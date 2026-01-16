// app/services/cache.service.js - COMPLETE FIXED VERSION
import { redisManager } from '../config/redis.js';
import analyticsService from './analytics.service.js';

class CacheService {
  constructor() {
    this.client = redisManager.getClient();
    this.cache = this.getCache(); // ✅ Initialize with proper cache object
    this.defaultTTL = {
      userProfile: 900,      // 15 minutes
      userMatches: 1800,     // 30 minutes
      userSwipes: 3600,      // 1 hour
      discovery: 300,        // 5 minutes
      recommendations: 600,  // 10 minutes
      otp: 300,             // 5 minutes
      session: 86400,       // 24 hours
      trending: 1800        // 30 minutes
    };
  }

  getCache() {
    const self = this;
    
    return {
      // ============ BASIC OPERATIONS ============
      set: async (key, value, ttl = 3600, options = {}) => {
        try {
          if (!self.client || !self.client.isReady) {
            console.warn(`⚠️ Redis client not available for set: ${key}`);
            return null;
          }
          
          const serialized = typeof value === 'object' ? JSON.stringify(value) : String(value);
          
          if (options.nx || options.xx || options.get || options.keepttl) {
            // Complex set with options
            return await self.client.set(key, serialized, {
              EX: ttl,
              NX: options.nx || false,
              XX: options.xx || false,
              GET: options.get || false,
              KEEPTTL: options.keepttl || false
            });
          } else {
            // Simple set with TTL
            return await self.client.setEx(key, ttl, serialized);
          }
        } catch (error) {
          console.warn(`⚠️ Cache set failed: ${key}`, error.message);
          return null;
        }
      },
      
      get: async (key, parseJSON = true) => {
        try {
          if (!self.client || !self.client.isReady) {
            console.warn(`⚠️ Redis client not available for get: ${key}`);
            return null;
          }
          
          const data = await self.client.get(key);
          if (!data) return null;
          
          if (parseJSON) {
            try {
              return JSON.parse(data);
            } catch {
              return data;
            }
          }
          return data;
        } catch (error) {
          console.warn(`⚠️ Cache get failed: ${key}`, error.message);
          return null;
        }
      },
      
      del: async (...keys) => {
        try {
          if (!self.client || !self.client.isReady) {
            console.warn(`⚠️ Redis client not available for del`);
            return 0;
          }
          
          // Flatten array if nested
          const keysToDelete = keys.flat();
          
          // Convert all to strings and filter out empty values
          const stringKeys = keysToDelete
            .map(k => String(k))
            .filter(k => k && k.trim() !== '');
          
          if (stringKeys.length === 0) return 0;
          
          return await self.client.del(stringKeys);
        } catch (error) {
          console.warn(`⚠️ Cache delete failed:`, error.message);
          return 0;
        }
      },
      
      exists: async (key) => {
        try {
          if (!self.client || !self.client.isReady) {
            console.warn(`⚠️ Redis client not available for exists: ${key}`);
            return false;
          }
          
          return (await self.client.exists(key)) === 1;
        } catch (error) {
          console.warn(`⚠️ Exists check failed: ${key}`, error.message);
          return false;
        }
      },
      
      ttl: async (key) => {
        try {
          if (!self.client || !self.client.isReady) {
            console.warn(`⚠️ Redis client not available for ttl: ${key}`);
            return -2;
          }
          
          return await self.client.ttl(key);
        } catch (error) {
          console.warn(`⚠️ TTL check failed: ${key}`, error.message);
          return -2;
        }
      },
      
      incr: async (key, ttl = null) => {
        try {
          if (!self.client || !self.client.isReady) {
            console.warn(`⚠️ Redis client not available for incr: ${key}`);
            return 0;
          }
          
          const value = await self.client.incr(key);
          if (ttl && value === 1) {
            await self.client.expire(key, ttl);
          }
          return value;
        } catch (error) {
          console.warn(`⚠️ Increment failed: ${key}`, error.message);
          return 0;
        }
      },
      
      // ============ LIST OPERATIONS ============
      lpush: async (key, value, limit = null) => {
        try {
          if (!self.client || !self.client.isReady) {
            console.warn(`⚠️ Redis client not available for lpush: ${key}`);
            return false;
          }
          
          const serialized = typeof value === 'object' ? JSON.stringify(value) : String(value);
          
          // Add to list
          await self.client.lPush(key, serialized);
          
          // Trim if limit is specified
          if (limit && limit > 0) {
            await self.client.lTrim(key, 0, limit - 1);
          }
          
          return true;
        } catch (error) {
          console.warn(`⚠️ LPUSH failed for ${key}:`, error.message);
          return false;
        }
      },
      
      lrange: async (key, start, end) => {
        try {
          if (!self.client || !self.client.isReady) {
            console.warn(`⚠️ Redis client not available for lrange: ${key}`);
            return [];
          }
          
          const data = await self.client.lRange(key, start, end);
          return data.map(item => {
            try {
              return JSON.parse(item);
            } catch {
              return item;
            }
          });
        } catch (error) {
          console.warn(`⚠️ LRANGE failed for ${key}:`, error.message);
          return [];
        }
      },
      
      llen: async (key) => {
        try {
          if (!self.client || !self.client.isReady) {
            console.warn(`⚠️ Redis client not available for llen: ${key}`);
            return 0;
          }
          
          return await self.client.lLen(key);
        } catch (error) {
          console.warn(`⚠️ LLEN failed for ${key}:`, error.message);
          return 0;
        }
      },
      
      // ============ HASH OPERATIONS ============
      hset: async (key, field, value, ttl = null) => {
        try {
          if (!self.client || !self.client.isReady) {
            console.warn(`⚠️ Redis client not available for hset: ${key}.${field}`);
            return false;
          }
          
          const serialized = typeof value === 'object' ? JSON.stringify(value) : String(value);
          await self.client.hSet(key, field, serialized);
          
          if (ttl) {
            await self.client.expire(key, ttl);
          }
          return true;
        } catch (error) {
          console.warn(`⚠️ HSET failed: ${key}.${field}`, error.message);
          return false;
        }
      },
      
      hget: async (key, field, parseJSON = true) => {
        try {
          if (!self.client || !self.client.isReady) {
            console.warn(`⚠️ Redis client not available for hget: ${key}.${field}`);
            return null;
          }
          
          const data = await self.client.hGet(key, field);
          if (!data) return null;
          
          if (parseJSON) {
            try {
              return JSON.parse(data);
            } catch {
              return data;
            }
          }
          return data;
        } catch (error) {
          console.warn(`⚠️ HGET failed: ${key}.${field}`, error.message);
          return null;
        }
      },
      
      hgetall: async (key) => {
        try {
          if (!self.client || !self.client.isReady) {
            console.warn(`⚠️ Redis client not available for hgetall: ${key}`);
            return {};
          }
          
          return await self.client.hGetAll(key);
        } catch (error) {
          console.warn(`⚠️ HGETALL failed: ${key}`, error.message);
          return {};
        }
      },
      
      hdel: async (key, field) => {
        try {
          if (!self.client || !self.client.isReady) {
            console.warn(`⚠️ Redis client not available for hdel: ${key}.${field}`);
            return 0;
          }
          
          return await self.client.hDel(key, field);
        } catch (error) {
          console.warn(`⚠️ HDEL failed: ${key}.${field}`, error.message);
          return 0;
        }
      },
      
      // ============ SET OPERATIONS ============
      sadd: async (key, ...members) => {
        try {
          if (!self.client || !self.client.isReady) {
            console.warn(`⚠️ Redis client not available for sadd: ${key}`);
            return 0;
          }
          
          // Convert all members to strings
          const stringMembers = members.map(m => String(m));
          return await self.client.sAdd(key, stringMembers);
        } catch (error) {
          console.warn(`⚠️ Set add failed: ${key}`, error.message);
          return 0;
        }
      },
      
      smembers: async (key) => {
        try {
          if (!self.client || !self.client.isReady) {
            console.warn(`⚠️ Redis client not available for smembers: ${key}`);
            return [];
          }
          
          return await self.client.sMembers(key);
        } catch (error) {
          console.warn(`⚠️ Set members failed: ${key}`, error.message);
          return [];
        }
      },
      
      srem: async (key, ...members) => {
        try {
          if (!self.client || !self.client.isReady) {
            console.warn(`⚠️ Redis client not available for srem: ${key}`);
            return 0;
          }
          
          // Convert all members to strings
          const stringMembers = members.map(m => String(m));
          return await self.client.sRem(key, stringMembers);
        } catch (error) {
          console.warn(`⚠️ Set remove failed: ${key}`, error.message);
          return 0;
        }
      },
      
      // ============ SCAN OPERATIONS ============
      scan: async (pattern = '*', count = 100) => {
        try {
          if (!self.client || !self.client.isReady) {
            console.warn(`⚠️ Redis client not available for scan: ${pattern}`);
            return [];
          }
          
          const keys = [];
          const options = { COUNT: count };
          
          // Only add MATCH if pattern is not '*'
          if (pattern !== '*') {
            options.MATCH = pattern;
          }
          
          for await (const key of self.client.scanIterator(options)) {
            keys.push(key);
            if (keys.length >= count) break;
          }
          return keys;
        } catch (error) {
          console.warn(`⚠️ Scan failed: ${pattern}`, error.message);
          return [];
        }
      },
      
      keys: async (pattern = '*') => {
        try {
          if (!self.client || !self.client.isReady) {
            console.warn(`⚠️ Redis client not available for keys: ${pattern}`);
            return [];
          }
          
          return await self.client.keys(pattern);
        } catch (error) {
          console.warn(`⚠️ Keys command failed: ${pattern}`, error.message);
          return [];
        }
      },
      
      // ============ BATCH OPERATIONS ============
      mset: async (keyValues, ttl = null) => {
        try {
          if (!self.client || !self.client.isReady) {
            console.warn(`⚠️ Redis client not available for mset`);
            return false;
          }
          
          const pipeline = self.client.multi();
          
          for (const [key, value] of Object.entries(keyValues)) {
            const serialized = typeof value === 'object' ? JSON.stringify(value) : String(value);
            if (ttl) {
              pipeline.setEx(key, ttl, serialized);
            } else {
              pipeline.set(key, serialized);
            }
          }
          
          await pipeline.exec();
          return true;
        } catch (error) {
          console.warn(`⚠️ MSET failed:`, error.message);
          return false;
        }
      },
      
      mget: async (keys, parseJSON = true) => {
        try {
          if (!self.client || !self.client.isReady) {
            console.warn(`⚠️ Redis client not available for mget`);
            return {};
          }
          
          const values = await self.client.mGet(keys);
          const result = {};
          
          keys.forEach((key, index) => {
            const value = values[index];
            if (value !== null) {
              if (parseJSON) {
                try {
                  result[key] = JSON.parse(value);
                } catch {
                  result[key] = value;
                }
              } else {
                result[key] = value;
              }
            }
          });
          
          return result;
        } catch (error) {
          console.warn(`⚠️ MGET failed:`, error.message);
          return {};
        }
      },
      
      // ============ EXPIRY OPERATIONS ============
      expire: async (key, ttl) => {
        try {
          if (!self.client || !self.client.isReady) {
            console.warn(`⚠️ Redis client not available for expire: ${key}`);
            return false;
          }
          
          return await self.client.expire(key, ttl);
        } catch (error) {
          console.warn(`⚠️ Expire failed: ${key}`, error.message);
          return false;
        }
      },
      
      persist: async (key) => {
        try {
          if (!self.client || !self.client.isReady) {
            console.warn(`⚠️ Redis client not available for persist: ${key}`);
            return false;
          }
          
          return await self.client.persist(key);
        } catch (error) {
          console.warn(`⚠️ Persist failed: ${key}`, error.message);
          return false;
        }
      },
      
      // ============ UTILITY METHODS ============
      getAllKeys: async (pattern = '*', limit = 1000) => {
        try {
          if (!self.client || !self.client.isReady) {
            console.warn(`⚠️ Redis client not available for getAllKeys: ${pattern}`);
            return [];
          }
          
          const keys = [];
          const options = { COUNT: 100 };
          
          if (pattern !== '*') {
            options.MATCH = pattern;
          }
          
          for await (const key of self.client.scanIterator(options)) {
            keys.push(key);
            if (keys.length >= limit) break;
          }
          return keys;
        } catch (error) {
          console.warn(`⚠️ GetAllKeys failed: ${pattern}`, error.message);
          return [];
        }
      },
      
      pipeline: () => {
        if (!self.client || !self.client.isReady) {
          console.warn(`⚠️ Redis client not available for pipeline`);
          return { exec: async () => [] };
        }
        return self.client.multi();
      },
      
      flushAll: async () => {
        try {
          if (!self.client || !self.client.isReady) {
            console.warn(`⚠️ Redis client not available for flushAll`);
            return false;
          }
          
          await self.client.flushAll();
          console.log('🧹 All Redis data flushed');
          return true;
        } catch (error) {
          console.error('❌ FlushAll failed:', error.message);
          return false;
        }
      },
      
      info: async (section = null) => {
        try {
          if (!self.client || !self.client.isReady) {
            console.warn(`⚠️ Redis client not available for info`);
            return null;
          }
          
          return await self.client.info(section);
        } catch (error) {
          console.warn(`⚠️ Info command failed:`, error.message);
          return null;
        }
      }
    };
  }

  // ============ USER CACHE ============
  async cacheUserProfile(userId, userData, ttl = null) {
    try {
      const key = `user:${userId}:profile`;
      const cacheTTL = ttl || this.defaultTTL.userProfile;
      
      const cacheData = {
        ...userData,
        _cachedAt: Date.now(),
        _cachedBy: 'cache.service',
        _version: '1.0'
      };
      
      // ✅ CHECK IF CLIENT IS AVAILABLE
      if (!this.client || !this.client.isReady) {
        console.warn(`⚠️ Redis client not available, skipping cache for user: ${userId}`);
        return false;
      }
      
      const success = await this.cache.set(key, cacheData, cacheTTL);
      
      if (success) {
        // Index user for quick invalidation
        try {
          await this.client.sAdd('cache:index:users', userId);
        } catch (error) {
          console.warn(`⚠️ Failed to index user ${userId} in Redis:`, error.message);
        }
        
        // Analytics
        try {
          await analyticsService.trackUserActivity(userId, 'profile_cached', {
            cacheKey: key,
            ttl: cacheTTL
          });
        } catch (analyticsError) {
          console.warn(`⚠️ Analytics tracking failed:`, analyticsError.message);
        }
      }
      
      return success;
    } catch (error) {
      console.warn(`⚠️ Cache user profile failed for ${userId}:`, error.message);
      return false;
    }
  }

  async getUserProfile(userId, updateAccess = true) {
    const key = `user:${userId}:profile`;
    const data = await this.cache.get(key);
    
    if (data && updateAccess) {
      // Update access time
      data._lastAccessed = Date.now();
      const ttl = await this.cache.ttl(key);
      
      if (ttl > 60) { // Only update if significant TTL remains
        await this.cache.set(key, data, ttl);
      }
      
      // Analytics
      await analyticsService.trackUserActivity(userId, 'profile_cache_hit', {
        cacheKey: key,
        servedFrom: 'redis'
      });
    }
    
    return data;
  }

  async cacheUserPreferences(userId, preferences) {
    const key = `user:${userId}:preferences`;
    return await this.cache.set(key, preferences, 86400); // 24 hours
  }

  async getUserPreferences(userId) {
    const key = `user:${userId}:preferences`;
    return await this.cache.get(key);
  }

  // ============ MATCH CACHE ============
  async cacheMatch(matchId, matchData, ttl = null) {
    const key = `match:${matchId}`;
    const cacheTTL = ttl || this.defaultTTL.userMatches;
    
    const cacheData = {
      ...matchData,
      _cachedAt: Date.now()
    };
    
    const success = await this.cache.set(key, cacheData, cacheTTL);
    
    if (success && matchData.users) {
      // Cache for each user
      for (const userId of matchData.users) {
        await this.addToUserMatches(userId, matchId);
      }
    }
    
    return success;
  }

  async getMatch(matchId) {
    const key = `match:${matchId}`;
    return await this.cache.get(key);
  }

  async addToUserMatches(userId, matchId) {
    const key = `user:${userId}:matches`;
    const matches = await this.cache.get(key) || [];
    
    if (!matches.includes(matchId)) {
      matches.push(matchId);
      await this.cache.set(key, matches, this.defaultTTL.userMatches);
    }
    
    return matches;
  }

  async getUserMatches(userId) {
    const key = `user:${userId}:matches`;
    const matchIds = await this.cache.get(key) || [];
    
    // Fetch all match details
    const matches = [];
    for (const matchId of matchIds.slice(0, 50)) { // Limit to 50 matches
      const match = await this.getMatch(matchId);
      if (match) {
        matches.push(match);
      }
    }
    
    return matches;
  }

  // ============ DISCOVERY & RECOMMENDATIONS ============
  async cacheDiscoveryProfiles(userId, profiles, ttl = null) {
    const key = `discovery:${userId}:profiles`;
    const cacheTTL = ttl || this.defaultTTL.discovery;
    
    const cacheData = {
      profiles,
      generatedAt: Date.now(),
      count: profiles.length,
      source: 'discovery_service'
    };
    
    return await this.cache.set(key, cacheData, cacheTTL);
  }

  async getDiscoveryProfiles(userId) {
    const key = `discovery:${userId}:profiles`;
    return await this.cache.get(key);
  }

  async cacheRecommendations(userId, recommendations, algorithm = 'collaborative') {
    const key = `recommendations:${userId}:${algorithm}`;
    const cacheData = {
      recommendations,
      algorithm,
      generatedAt: Date.now(),
      score: recommendations.length > 0 ? recommendations[0].score || 0 : 0
    };
    
    return await this.cache.set(key, cacheData, this.defaultTTL.recommendations);
  }

  async getRecommendations(userId, algorithm = 'collaborative') {
    const key = `recommendations:${userId}:${algorithm}`;
    return await this.cache.get(key);
  }

  // ============ TRENDING DATA ============
  async cacheTrendingProfiles(profiles, location = 'global', ttl = null) {
    const key = `trending:${location}`;
    const cacheTTL = ttl || this.defaultTTL.trending;
    
    const cacheData = {
      profiles,
      location,
      updatedAt: Date.now(),
      count: profiles.length
    };
    
    return await this.cache.set(key, cacheData, cacheTTL);
  }

  async getTrendingProfiles(location = 'global') {
    const key = `trending:${location}`;
    return await this.cache.get(key);
  }

  async updateTrendingScore(userId, scoreChange = 1) {
    const key = 'trending:scores';
    const currentScore = await this.client.zScore(key, userId) || 0;
    const newScore = currentScore + scoreChange;
    
    await this.client.zAdd(key, { score: newScore, value: userId });
    
    // Keep only top 1000
    await this.client.zRemRangeByRank(key, 0, -1001);
    
    return newScore;
  }

  // ============ SWIPE CACHE ============
  async cacheSwipe(swipeData) {
    const { userId, targetId, direction } = swipeData;
    
    // Cache individual swipe
    const swipeKey = `swipe:${userId}:${targetId}`;
    await this.cache.set(swipeKey, swipeData, 86400); // 24 hours
    
    // Add to user's swipe history
    const historyKey = `user:${userId}:swipes`;
    await this.cache.lpush(historyKey, swipeData, 1000); // Last 1000 swipes
    
    // Update analytics
    await analyticsService.recordSwipe(userId, targetId, direction);
    
    return true;
  }

  async getUserSwipes(userId, limit = 100) {
    const key = `user:${userId}:swipes`;
    return await this.cache.lrange(key, 0, limit - 1);
  }

  async hasSwiped(userId, targetId) {
    const key = `swipe:${userId}:${targetId}`;
    return await this.cache.exists(key);
  }

  // ============ CACHE INVALIDATION ============
  async invalidateUserCache(userId) {
    const patterns = [
      `user:${userId}:profile`,
      `user:${userId}:preferences`,
      `user:${userId}:matches`,
      `user:${userId}:swipes`,
      `discovery:${userId}:profiles`,
      `recommendations:${userId}:*`,
      `swipe:${userId}:*`
    ];
    
    let totalInvalidated = 0;
    
    for (const pattern of patterns) {
      const count = await this.cache.del(pattern);
      totalInvalidated += count;
    }
    
    // Remove from index
    await this.client.sRem('cache:index:users', userId);
    
    console.log(`🗑️ Invalidated ${totalInvalidated} cache entries for user: ${userId}`);
    
    return totalInvalidated;
  }

  async invalidateMatchCache(matchId) {
    const patterns = [
      `match:${matchId}`,
      `match:messages:${matchId}:*`
    ];
    
    let totalInvalidated = 0;
    
    for (const pattern of patterns) {
      const count = await this.cache.del(pattern);
      totalInvalidated += count;
    }
    
    return totalInvalidated;
  }

  async invalidateAllDiscoveryCache() {
    const pattern = 'discovery:*';
    return await this.cache.del(pattern);
  }

  // ============ BATCH OPERATIONS ============
  async cacheMultipleUsers(users, ttl = null) {
    const pipeline = this.client.multi();
    const cacheTTL = ttl || this.defaultTTL.userProfile;
    
    users.forEach(user => {
      const key = `user:${user._id}:profile`;
      const cacheData = {
        ...user.toObject ? user.toObject() : user,
        _cachedAt: Date.now(),
        _batch: true
      };
      
      pipeline.setEx(key, cacheTTL, JSON.stringify(cacheData));
      pipeline.sAdd('cache:index:users', user._id);
    });
    
    await pipeline.exec();
    return users.length;
  }

  async getMultipleUsers(userIds) {
    const pipeline = this.client.multi();
    
    userIds.forEach(userId => {
      pipeline.get(`user:${userId}:profile`);
    });
    
    const results = await pipeline.exec();
    const users = [];
    
    for (let i = 0; i < results.length; i++) {
      if (results[i]) {
        try {
          users.push(JSON.parse(results[i]));
        } catch {
          users.push(null);
        }
      } else {
        users.push(null);
      }
    }
    
    return users;
  }

  // ============ CACHE STATISTICS ============
  async getCacheStats() {
    const patterns = [
      'user:*:profile',
      'match:*',
      'discovery:*',
      'recommendations:*',
      'trending:*'
    ];
    
    const stats = {
      total: 0,
      byType: {},
      memory: await this.getMemoryUsage(),
      hitRate: await this.calculateHitRate(),
      uptime: process.uptime()
    };
    
    for (const pattern of patterns) {
      const keys = await this.cache.scan(pattern);
      const type = pattern.split(':')[0];
      stats.byType[type] = keys.length;
      stats.total += keys.length;
    }
    
    return stats;
  }

  async getMemoryUsage() {
    try {
      const info = await this.cache.info('memory');
      return {
        used: info.match(/used_memory_human:(\S+)/)?.[1] || 'unknown',
        peak: info.match(/used_memory_peak_human:(\S+)/)?.[1] || 'unknown',
        fragmentation: info.match(/mem_fragmentation_ratio:(\S+)/)?.[1] || 'unknown'
      };
    } catch {
      return { used: 'unknown', peak: 'unknown', fragmentation: 'unknown' };
    }
  }

  async calculateHitRate() {
    try {
      const info = await this.cache.info('stats');
      const keyspaceHits = parseInt(info.match(/keyspace_hits:(\d+)/)?.[1] || 0);
      const keyspaceMisses = parseInt(info.match(/keyspace_misses:(\d+)/)?.[1] || 0);
      const total = keyspaceHits + keyspaceMisses;
      
      return total > 0 ? ((keyspaceHits / total) * 100).toFixed(2) : 0;
    } catch {
      return 0;
    }
  }

  // ============ CACHE WARMING ============
  async warmUpCache() {
    console.log('🔥 Starting cache warm-up...');
    
    const warmUpTasks = [
      this.warmUpTrendingProfiles(),
      this.warmUpActiveUsers(),
      this.warmUpPopularMatches()
    ];
    
    await Promise.all(warmUpTasks);
    
    console.log('✅ Cache warm-up completed');
  }

  async warmUpTrendingProfiles() {
    // Fetch and cache trending profiles globally
    // This would typically come from your database
    const trendingProfiles = []; // Fetch from DB
    
    if (trendingProfiles.length > 0) {
      await this.cacheTrendingProfiles(trendingProfiles, 'global');
      console.log(`🔥 Warmed up ${trendingProfiles.length} trending profiles`);
    }
  }

  async warmUpActiveUsers() {
    // Fetch most active users and cache their profiles
    // This would typically come from your database
    const activeUsers = []; // Fetch from DB
    
    if (activeUsers.length > 0) {
      await this.cacheMultipleUsers(activeUsers);
      console.log(`🔥 Warmed up ${activeUsers.length} active user profiles`);
    }
  }

  async warmUpPopularMatches() {
    // Fetch popular matches and cache them
    // This would typically come from your database
    const popularMatches = []; // Fetch from DB
    
    for (const match of popularMatches.slice(0, 100)) {
      await this.cacheMatch(match._id, match);
    }
    
    console.log(`🔥 Warmed up ${Math.min(popularMatches.length, 100)} popular matches`);
  }

  // ============ HEALTH CHECK ============
  async healthCheck() {
    try {
      const start = Date.now();
      await this.client.setEx('health:cache:check', 10, 'OK');
      const value = await this.client.get('health:cache:check');
      const latency = Date.now() - start;
      
      const stats = await this.getCacheStats();
      
      return {
        status: 'healthy',
        latency: `${latency}ms`,
        connected: redisManager.getStatus(),
        cacheStats: stats,
        timestamp: new Date().toISOString()
      };
    } catch (error) {
      return {
        status: 'unhealthy',
        error: error.message,
        connected: false,
        timestamp: new Date().toISOString()
      };
    }
  }

  // ============ UTILITY METHODS ============
  async getKeyCount(pattern = '*') {
    const keys = await this.cache.scan(pattern);
    return keys.length;
  }

  async clearAllCache() {
    console.log('⚠️ Clearing ALL cache data...');
    
    const patterns = [
      'user:*',
      'match:*',
      'discovery:*',
      'recommendations:*',
      'trending:*',
      'swipe:*',
      'cache:*'
    ];
    
    let totalCleared = 0;
    
    for (const pattern of patterns) {
      const count = await this.cache.del(pattern);
      totalCleared += count;
    }
    
    console.log(`🧹 Cleared ${totalCleared} cache entries`);
    return totalCleared;
  }

  async getCacheKeys(pattern = '*', limit = 100) {
    return await this.cache.scan(pattern, limit);
  }
}

// Create singleton instance
const cacheService = new CacheService();

// Export for use
export { CacheService };
export default cacheService;
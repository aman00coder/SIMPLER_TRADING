// app/config/redis.js - COMPLETE FIXED VERSION WITH FALLBACK SUPPORT
import { createClient } from 'redis';
import { EventEmitter } from 'events';

class RedisManager extends EventEmitter {
  constructor() {
    super();
    this.client = null;
    this.subscriber = null;
    this.publisher = null;
    this.isConnected = false;
    this.fallbackMode = false;
    this.memoryCache = new Map(); // Fallback storage
    this.retryCount = 0;
    this.maxRetries = 5;
    this.connectionAttempts = 0;
    this.stats = {
      hits: 0,
      misses: 0,
      sets: 0,
      deletes: 0,
      errors: 0
    };
  }

  async initialize() {
    if (this.client && this.isConnected) {
      console.log('✅ Redis already connected');
      return this.client;
    }
    
    console.log(`🌐 Attempting Redis connection to: ${process.env.REDIS_HOST || 'localhost'}:${process.env.REDIS_PORT || 6379}`);
    
    // Check if we should skip Redis Cloud and use localhost
    const shouldUseLocal = await this.shouldUseLocalFallback();
    if (shouldUseLocal) {
      console.log('⚠️ Using local Redis fallback');
      process.env.REDIS_HOST = 'localhost';
      process.env.REDIS_PORT = '6379';
      process.env.REDIS_PASSWORD = '';
    }
    
    try {
      const config = {
        password: process.env.REDIS_PASSWORD || undefined,
        socket: {
          host: process.env.REDIS_HOST || 'localhost',
          port: parseInt(process.env.REDIS_PORT || '6379'),
          connectTimeout: 10000,
          reconnectStrategy: (retries) => {
            this.retryCount = retries;
            this.connectionAttempts++;
            
            if (retries > 3) {
              console.log(`❌ Redis: Max retries reached (${retries})`);
              this.enableFallbackMode();
              return false;
            }
            
            const delay = Math.min(retries * 1000, 5000);
            console.log(`🔄 Redis: Retry ${retries} in ${delay}ms`);
            return delay;
          }
        },
        pingInterval: 30000,
        maxRetriesPerRequest: 1,
        enable_offline_queue: false
      };

      console.log('🔍 Testing Redis connection...');
      
      // Create and test connection with timeout
      const testClient = createClient(config);
      
      // Set up test client error handler
      testClient.on('error', (err) => {
        console.error(`❌ Redis test connection error: ${err.message}`);
      });
      
      // Try to connect with timeout
      try {
        const connectPromise = testClient.connect();
        const timeoutPromise = new Promise((_, reject) => {
          setTimeout(() => reject(new Error('Connection timeout after 15 seconds')), 15000);
        });
        
        await Promise.race([connectPromise, timeoutPromise]);
        
        // Test the connection
        const pong = await testClient.ping();
        if (pong !== 'PONG') {
          throw new Error('Invalid PING response');
        }
        
        await testClient.quit();
        console.log('✅ Redis connection test successful');
      } catch (testError) {
        console.error(`❌ Redis connection test failed: ${testError.message}`);
        throw testError;
      }
      
      // Create main clients
      this.client = createClient(config);
      this.subscriber = this.client.duplicate();
      this.publisher = this.client.duplicate();
      
      // Setup event handlers for all clients
      this.setupEventHandlers(this.client, 'Main');
      this.setupEventHandlers(this.subscriber, 'Subscriber');
      this.setupEventHandlers(this.publisher, 'Publisher');
      
      // Connect all clients
      console.log('🔗 Connecting Redis clients...');
      await Promise.all([
        this.client.connect().then(() => console.log('✅ Main client connected')),
        this.subscriber.connect().then(() => console.log('✅ Subscriber client connected')),
        this.publisher.connect().then(() => console.log('✅ Publisher client connected'))
      ]);
      
      // Verify all connections
      await this.client.ping();
      await this.subscriber.ping();
      await this.publisher.ping();
      
      this.isConnected = true;
      this.fallbackMode = false;
      this.retryCount = 0;
      
      console.log('✅ Redis: All connections established and verified');
      this.emit('connected');
      
      // Start health monitoring
      this.startHealthMonitor();
      
      return this.client;
      
    } catch (error) {
      console.error(`❌ Redis initialization failed: ${error.message}`);
      this.emit('error', error);
      return this.enableFallbackMode();
    }
  }

  async shouldUseLocalFallback() {
    const host = process.env.REDIS_HOST;
    
    // If already localhost, use it
    if (host === 'localhost' || host === '127.0.0.1') {
      return false;
    }
    
    // Check for cloud hostnames that often have DNS issues
    if (host?.includes('redislabs.com') || 
        host?.includes('redis-') && host?.includes('.cloud.redislabs.com')) {
      console.log('⚠️ Detected Redis Cloud hostname');
      
      try {
        // Try DNS resolution
        const dns = await import('dns');
        await dns.promises.lookup(host);
        console.log(`✅ DNS resolution successful for ${host}`);
        return false;
      } catch (dnsError) {
        console.error(`❌ DNS resolution failed for ${host}: ${dnsError.message}`);
        return true;
      }
    }
    
    return false;
  }

  enableFallbackMode() {
    if (this.fallbackMode) {
      return this.getFallbackClient();
    }
    
    this.fallbackMode = true;
    this.isConnected = false;
    this.memoryCache.clear();
    
    console.log('\n⚠️=========================================');
    console.log('⚠️ REDIS FALLBACK MODE ACTIVATED');
    console.log('⚠️=========================================');
    console.log('⚠️ Using in-memory cache instead of Redis');
    console.log('⚠️ Session data will not persist across restarts');
    console.log('⚠️ Cache will be lost on server restart');
    console.log('⚠️ Some real-time features may be limited');
    console.log('⚠️=========================================');
    console.log('💡 TO FIX REDIS:');
    console.log('   1. Install Redis locally:');
    console.log('      - Windows: Download from https://github.com/tporadowski/redis/releases');
    console.log('      - Mac: brew install redis && brew services start redis');
    console.log('      - Ubuntu: sudo apt install redis-server');
    console.log('   2. Update .env file:');
    console.log('      REDIS_HOST=localhost');
    console.log('      REDIS_PORT=6379');
    console.log('      REDIS_PASSWORD=');
    console.log('   3. Restart your application');
    console.log('⚠️=========================================\n');
    
    // Create fallback clients
    this.client = this.createFallbackClient('Main');
    this.subscriber = this.createFallbackClient('Subscriber');
    this.publisher = this.createFallbackClient('Publisher');
    
    this.emit('fallback');
    return this.client;
  }

  createFallbackClient(label) {
    const client = {
      label: label,
      isOpen: true,
      isReady: true,
      connect: async () => {
        console.log(`⚠️ ${label}: Connected (fallback mode)`);
        return client;
      },
      quit: async () => {
        console.log(`⚠️ ${label}: Disconnected (fallback mode)`);
        client.isOpen = false;
        client.isReady = false;
        return 'OK';
      },
      ping: async () => 'PONG',
      on: (event, handler) => {
        if (event === 'connect') {
          setTimeout(() => handler(), 10);
        }
        return client;
      },
      duplicate: () => this.createFallbackClient(`${label}_duplicate`),
      
      // Basic operations
      set: async (key, value, options = {}) => {
        const serialized = typeof value === 'object' ? JSON.stringify(value) : String(value);
        this.memoryCache.set(key, {
          value: serialized,
          expiry: options.EX ? Date.now() + (options.EX * 1000) : null
        });
        this.stats.sets++;
        return 'OK';
      },
      
      setEx: async (key, ttl, value) => {
        const serialized = typeof value === 'object' ? JSON.stringify(value) : String(value);
        this.memoryCache.set(key, {
          value: serialized,
          expiry: Date.now() + (ttl * 1000)
        });
        this.stats.sets++;
        return 'OK';
      },
      
      get: async (key) => {
        const item = this.memoryCache.get(key);
        if (!item) {
          this.stats.misses++;
          return null;
        }
        
        if (item.expiry && Date.now() > item.expiry) {
          this.memoryCache.delete(key);
          this.stats.misses++;
          return null;
        }
        
        this.stats.hits++;
        return item.value;
      },
      
      del: async (...keys) => {
        let deleted = 0;
        keys.flat().forEach(key => {
          if (this.memoryCache.delete(key)) deleted++;
        });
        this.stats.deletes += deleted;
        return deleted;
      },
      
      exists: async (key) => {
        const item = this.memoryCache.get(key);
        if (!item) return 0;
        
        if (item.expiry && Date.now() > item.expiry) {
          this.memoryCache.delete(key);
          return 0;
        }
        
        return 1;
      },
      
      expire: async (key, ttl) => {
        const item = this.memoryCache.get(key);
        if (!item) return 0;
        
        item.expiry = Date.now() + (ttl * 1000);
        this.memoryCache.set(key, item);
        return 1;
      },
      
      ttl: async (key) => {
        const item = this.memoryCache.get(key);
        if (!item || !item.expiry) return -2;
        
        const remaining = Math.max(0, Math.floor((item.expiry - Date.now()) / 1000));
        return remaining;
      },
      
      incr: async (key) => {
        const item = this.memoryCache.get(key);
        let value = 1;
        
        if (item) {
          try {
            value = parseInt(item.value) + 1;
          } catch {
            value = 1;
          }
        }
        
        this.memoryCache.set(key, {
          value: value.toString(),
          expiry: item?.expiry || null
        });
        
        return value;
      },
      
      keys: async (pattern = '*') => {
        const allKeys = Array.from(this.memoryCache.keys());
        
        if (pattern === '*') {
          return allKeys;
        }
        
        // Simple pattern matching (supports * at end)
        const regex = new RegExp('^' + pattern.replace(/\*/g, '.*') + '$');
        return allKeys.filter(key => regex.test(key));
      },
      
      scanIterator: function*(options = {}) {
        const keys = Array.from(this.memoryCache.keys());
        const pattern = options.MATCH;
        
        let filteredKeys = keys;
        if (pattern && pattern !== '*') {
          const regex = new RegExp('^' + pattern.replace(/\*/g, '.*') + '$');
          filteredKeys = keys.filter(key => regex.test(key));
        }
        
        for (const key of filteredKeys) {
          yield key;
        }
      },
      
      // Hash operations
      hSet: async (key, field, value) => {
        let hash = this.memoryCache.get(key);
        if (!hash || !hash.isHash) {
          hash = { isHash: true, value: {} };
        }
        
        hash.value[field] = typeof value === 'object' ? JSON.stringify(value) : String(value);
        this.memoryCache.set(key, hash);
        return 1;
      },
      
      hGet: async (key, field) => {
        const hash = this.memoryCache.get(key);
        if (!hash || !hash.isHash) return null;
        
        return hash.value[field] || null;
      },
      
      hGetAll: async (key) => {
        const hash = this.memoryCache.get(key);
        if (!hash || !hash.isHash) return {};
        
        return { ...hash.value };
      },
      
      hDel: async (key, ...fields) => {
        const hash = this.memoryCache.get(key);
        if (!hash || !hash.isHash) return 0;
        
        let deleted = 0;
        fields.forEach(field => {
          if (hash.value[field]) {
            delete hash.value[field];
            deleted++;
          }
        });
        
        return deleted;
      },
      
      // Set operations
      sAdd: async (key, ...members) => {
        let set = this.memoryCache.get(key);
        if (!set || !set.isSet) {
          set = { isSet: true, value: new Set() };
        }
        
        let added = 0;
        members.forEach(member => {
          if (!set.value.has(member)) {
            set.value.add(member);
            added++;
          }
        });
        
        this.memoryCache.set(key, set);
        return added;
      },
      
      sMembers: async (key) => {
        const set = this.memoryCache.get(key);
        if (!set || !set.isSet) return [];
        
        return Array.from(set.value);
      },
      
      sRem: async (key, ...members) => {
        const set = this.memoryCache.get(key);
        if (!set || !set.isSet) return 0;
        
        let removed = 0;
        members.forEach(member => {
          if (set.value.delete(member)) {
            removed++;
          }
        });
        
        return removed;
      },
      
      // List operations
      lPush: async (key, ...elements) => {
        let list = this.memoryCache.get(key);
        if (!list || !list.isList) {
          list = { isList: true, value: [] };
        }
        
        list.value.unshift(...elements.map(e => 
          typeof e === 'object' ? JSON.stringify(e) : String(e)
        ));
        this.memoryCache.set(key, list);
        return list.value.length;
      },
      
      rPush: async (key, ...elements) => {
        let list = this.memoryCache.get(key);
        if (!list || !list.isList) {
          list = { isList: true, value: [] };
        }
        
        list.value.push(...elements.map(e => 
          typeof e === 'object' ? JSON.stringify(e) : String(e)
        ));
        this.memoryCache.set(key, list);
        return list.value.length;
      },
      
      lRange: async (key, start, stop) => {
        const list = this.memoryCache.get(key);
        if (!list || !list.isList) return [];
        
        const effectiveStop = stop === -1 ? list.value.length - 1 : stop;
        return list.value.slice(start, effectiveStop + 1);
      },
      
      // Multi/exec
      multi: () => {
        const commands = [];
        const multiClient = {
          set: (...args) => {
            commands.push({ cmd: 'set', args });
            return multiClient;
          },
          get: (...args) => {
            commands.push({ cmd: 'get', args });
            return multiClient;
          },
          del: (...args) => {
            commands.push({ cmd: 'del', args });
            return multiClient;
          },
          exec: async () => {
            const results = [];
            for (const command of commands) {
              try {
                const result = await client[command.cmd](...command.args);
                results.push([null, result]);
              } catch (error) {
                results.push([error, null]);
              }
            }
            return results;
          }
        };
        return multiClient;
      },
      
      // Pub/Sub simulation
      publish: async (channel, message) => {
        console.log(`⚠️ PUBLISH (fallback): ${channel} -> ${message}`);
        return 0; // No subscribers in fallback
      },
      
      subscribe: async (channel, callback) => {
        console.log(`⚠️ SUBSCRIBE (fallback): ${channel}`);
        return 'OK';
      },
      
      unsubscribe: async (channel) => {
        console.log(`⚠️ UNSUBSCRIBE (fallback): ${channel}`);
        return 'OK';
      }
    };
    
    return client;
  }

  setupEventHandlers(client, label) {
    client.on('connect', () => {
      console.log(`✅ Redis ${label}: Connected`);
      this.emit(`${label}:connect`);
    });

    client.on('ready', () => {
      console.log(`🚀 Redis ${label}: Ready`);
      this.emit(`${label}:ready`);
    });

    client.on('error', (err) => {
      console.error(`❌ Redis ${label} Error:`, err.message);
      this.stats.errors++;
      this.emit(`${label}:error`, err);
      
      if (err.code === 'ENOTFOUND') {
        console.error(`🌐 DNS Error: Cannot resolve host "${process.env.REDIS_HOST}"`);
        console.log('💡 Tip: Try using local Redis: REDIS_HOST=localhost');
      }
    });

    client.on('end', () => {
      console.log(`🔌 Redis ${label}: Connection ended`);
      this.isConnected = false;
      this.emit(`${label}:end`);
    });

    client.on('reconnecting', () => {
      console.log(`🔄 Redis ${label}: Reconnecting...`);
      this.emit(`${label}:reconnecting`);
    });
  }

  startHealthMonitor() {
    if (this.healthMonitor) {
      clearInterval(this.healthMonitor);
    }
    
    this.healthMonitor = setInterval(async () => {
      if (!this.isConnected || this.fallbackMode) return;
      
      try {
        await this.client.ping();
      } catch (error) {
        console.error('❌ Redis health check failed:', error.message);
        this.isConnected = false;
        this.emit('health:failed', error);
      }
    }, 60000); // Check every minute
    
    console.log('📊 Redis health monitor started');
  }

  async healthCheck() {
    if (this.fallbackMode) {
      return {
        status: 'fallback',
        message: 'Running in memory cache mode',
        connected: false,
        fallbackMode: true,
        memoryItems: this.memoryCache.size,
        stats: this.stats,
        uptime: process.uptime()
      };
    }
    
    if (!this.isConnected || !this.client) {
      return {
        status: 'disconnected',
        connected: false,
        fallbackMode: false,
        error: 'Redis client not initialized',
        uptime: process.uptime()
      };
    }
    
    try {
      const start = Date.now();
      await this.client.setEx('health:check', 10, 'OK');
      const value = await this.client.get('health:check');
      const latency = Date.now() - start;
      
      const info = await this.getMemoryInfo();
      
      return {
        status: value === 'OK' ? 'healthy' : 'unhealthy',
        latency: `${latency}ms`,
        connected: this.isConnected,
        fallbackMode: false,
        memory: info,
        stats: this.stats,
        retryCount: this.retryCount,
        connectionAttempts: this.connectionAttempts,
        uptime: process.uptime()
      };
    } catch (error) {
      return {
        status: 'unhealthy',
        error: error.message,
        connected: false,
        fallbackMode: false,
        stats: this.stats,
        retryCount: this.retryCount,
        connectionAttempts: this.connectionAttempts,
        uptime: process.uptime()
      };
    }
  }

  async getMemoryInfo() {
    if (this.fallbackMode) {
      return {
        used: `${this.memoryCache.size} items`,
        peak: 'N/A',
        keys: this.memoryCache.size
      };
    }
    
    try {
      const info = await this.client.info('memory');
      const used = info.match(/used_memory_human:(\S+)/)?.[1] || 'unknown';
      const peak = info.match(/used_memory_peak_human:(\S+)/)?.[1] || 'unknown';
      const keys = await this.client.dbSize();
      
      return { used, peak, keys };
    } catch {
      return { used: 'unknown', peak: 'unknown', keys: 'unknown' };
    }
  }

  getCache() {
    if (this.fallbackMode) {
      return this.getFallbackCache();
    }
    
    const self = this;
    
    return {
      // SET with options
      set: async (key, value, ttl = 3600, options = {}) => {
        try {
          const serialized = typeof value === 'object' ? JSON.stringify(value) : String(value);
          
          if (options.nx || options.xx || options.get || options.keepttl) {
            return await self.client.set(key, serialized, {
              EX: ttl,
              NX: options.nx || false,
              XX: options.xx || false,
              GET: options.get || false,
              KEEPTTL: options.keepttl || false
            });
          } else {
            return await self.client.setEx(key, ttl, serialized);
          }
        } catch (error) {
          console.warn(`⚠️ Cache set failed: ${key}`, error.message);
          self.stats.errors++;
          return null;
        }
      },
      
      get: async (key, parseJSON = true) => {
        try {
          const data = await self.client.get(key);
          if (!data) {
            self.stats.misses++;
            return null;
          }
          
          self.stats.hits++;
          
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
          self.stats.errors++;
          return null;
        }
      },
      
      del: async (...keys) => {
        try {
          const keysToDelete = keys.flat();
          const stringKeys = keysToDelete
            .map(k => String(k))
            .filter(k => k && k.trim() !== '');
          
          if (stringKeys.length === 0) return 0;
          
          const result = await self.client.del(stringKeys);
          self.stats.deletes += result;
          return result;
        } catch (error) {
          console.warn(`⚠️ Cache delete failed:`, error.message);
          self.stats.errors++;
          return 0;
        }
      },
      
      exists: async (key) => {
        try {
          return (await self.client.exists(key)) === 1;
        } catch (error) {
          console.warn(`⚠️ Exists check failed: ${key}`, error.message);
          self.stats.errors++;
          return false;
        }
      },
      
      ttl: async (key) => {
        try {
          return await self.client.ttl(key);
        } catch (error) {
          console.warn(`⚠️ TTL check failed: ${key}`, error.message);
          self.stats.errors++;
          return -2;
        }
      },
      
      hset: async (key, field, value, ttl = null) => {
        try {
          const serialized = typeof value === 'object' ? JSON.stringify(value) : String(value);
          await self.client.hSet(key, field, serialized);
          
          if (ttl) {
            await self.client.expire(key, ttl);
          }
          return true;
        } catch (error) {
          console.warn(`⚠️ Hash set failed: ${key}.${field}`, error.message);
          self.stats.errors++;
          return false;
        }
      },
      
      hget: async (key, field, parseJSON = true) => {
        try {
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
          console.warn(`⚠️ Hash get failed: ${key}.${field}`, error.message);
          self.stats.errors++;
          return null;
        }
      },
      
      hgetall: async (key) => {
        try {
          return await self.client.hGetAll(key);
        } catch (error) {
          console.warn(`⚠️ Hash getall failed: ${key}`, error.message);
          self.stats.errors++;
          return {};
        }
      },
      
      hdel: async (key, field) => {
        try {
          return await self.client.hDel(key, field);
        } catch (error) {
          console.warn(`⚠️ Hash delete failed: ${key}.${field}`, error.message);
          self.stats.errors++;
          return 0;
        }
      },
      
      sadd: async (key, ...members) => {
        try {
          const stringMembers = members.map(m => String(m));
          return await self.client.sAdd(key, stringMembers);
        } catch (error) {
          console.warn(`⚠️ Set add failed: ${key}`, error.message);
          self.stats.errors++;
          return 0;
        }
      },
      
      smembers: async (key) => {
        try {
          return await self.client.sMembers(key);
        } catch (error) {
          console.warn(`⚠️ Set members failed: ${key}`, error.message);
          self.stats.errors++;
          return [];
        }
      },
      
      srem: async (key, ...members) => {
        try {
          const stringMembers = members.map(m => String(m));
          return await self.client.sRem(key, stringMembers);
        } catch (error) {
          console.warn(`⚠️ Set remove failed: ${key}`, error.message);
          self.stats.errors++;
          return 0;
        }
      },
      
      incr: async (key, ttl = null) => {
        try {
          const value = await self.client.incr(key);
          if (ttl && value === 1) {
            await self.client.expire(key, ttl);
          }
          return value;
        } catch (error) {
          console.warn(`⚠️ Increment failed: ${key}`, error.message);
          self.stats.errors++;
          return 0;
        }
      },
      
      scan: async (pattern = '*', count = 100) => {
        try {
          const keys = [];
          const options = { COUNT: count };
          
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
          self.stats.errors++;
          return [];
        }
      },
      
      keys: async (pattern = '*') => {
        try {
          return await self.client.keys(pattern);
        } catch (error) {
          console.warn(`⚠️ Keys command failed: ${pattern}`, error.message);
          self.stats.errors++;
          return [];
        }
      },
      
      mset: async (keyValues, ttl = null) => {
        try {
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
          self.stats.errors++;
          return false;
        }
      },
      
      mget: async (keys, parseJSON = true) => {
        try {
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
          self.stats.errors++;
          return {};
        }
      },
      
      expire: async (key, ttl) => {
        try {
          return await self.client.expire(key, ttl);
        } catch (error) {
          console.warn(`⚠️ Expire failed: ${key}`, error.message);
          self.stats.errors++;
          return false;
        }
      },
      
      persist: async (key) => {
        try {
          return await self.client.persist(key);
        } catch (error) {
          console.warn(`⚠️ Persist failed: ${key}`, error.message);
          self.stats.errors++;
          return false;
        }
      },
      
      getAllKeys: async (pattern = '*', limit = 1000) => {
        try {
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
          self.stats.errors++;
          return [];
        }
      },
      
      pipeline: () => {
        return self.client.multi();
      },
      
      flushAll: async () => {
        try {
          await self.client.flushAll();
          console.log('🧹 All Redis data flushed');
          return true;
        } catch (error) {
          console.error('❌ FlushAll failed:', error.message);
          self.stats.errors++;
          return false;
        }
      },
      
      info: async (section = null) => {
        try {
          return await self.client.info(section);
        } catch (error) {
          console.warn(`⚠️ Info command failed:`, error.message);
          self.stats.errors++;
          return null;
        }
      }
    };
  }

  getFallbackCache() {
    const self = this;
    
    return {
      set: async (key, value, ttl = 3600) => {
        self.memoryCache.set(key, {
          value: value,
          expiry: ttl ? Date.now() + (ttl * 1000) : null
        });
        self.stats.sets++;
        console.log(`⚠️ Fallback SET: ${key}`);
        return 'OK';
      },
      
      get: async (key, parseJSON = true) => {
        const item = self.memoryCache.get(key);
        if (!item) {
          self.stats.misses++;
          return null;
        }
        
        if (item.expiry && Date.now() > item.expiry) {
          self.memoryCache.delete(key);
          self.stats.misses++;
          return null;
        }
        
        self.stats.hits++;
        return item.value;
      },
      
      del: async (...keys) => {
        let deleted = 0;
        keys.flat().forEach(key => {
          if (self.memoryCache.delete(key)) {
            deleted++;
          }
        });
        self.stats.deletes += deleted;
        return deleted;
      },
      
      exists: async (key) => {
        return self.memoryCache.has(key);
      },
      
      ttl: async (key) => {
        const item = self.memoryCache.get(key);
        if (!item || !item.expiry) return -2;
        
        const remaining = Math.max(0, Math.floor((item.expiry - Date.now()) / 1000));
        return remaining;
      },
      
      incr: async (key, ttl = null) => {
        const item = self.memoryCache.get(key);
        let value = 1;
        
        if (item && typeof item.value === 'number') {
          value = item.value + 1;
        } else if (item) {
          try {
            value = parseInt(item.value) + 1;
          } catch {
            value = 1;
          }
        }
        
        self.memoryCache.set(key, {
          value: value,
          expiry: ttl ? Date.now() + (ttl * 1000) : (item?.expiry || null)
        });
        
        return value;
      },
      
      keys: async (pattern = '*') => {
        const allKeys = Array.from(self.memoryCache.keys());
        if (pattern === '*') return allKeys;
        
        const regex = new RegExp('^' + pattern.replace(/\*/g, '.*') + '$');
        return allKeys.filter(key => regex.test(key));
      },
      
      scan: async (pattern = '*', count = 100) => {
        const keys = await this.keys(pattern);
        return keys.slice(0, count);
      },
      
      flushAll: async () => {
        const size = self.memoryCache.size;
        self.memoryCache.clear();
        console.log(`🧹 Fallback cache cleared: ${size} items removed`);
        return true;
      },
      
      hset: async (key, field, value) => {
        let hash = self.memoryCache.get(key);
        if (!hash || !hash.isHash) {
          hash = { isHash: true, value: {} };
        }
        
        hash.value[field] = value;
        self.memoryCache.set(key, hash);
        return 1;
      },
      
      hget: async (key, field) => {
        const hash = self.memoryCache.get(key);
        if (!hash || !hash.isHash) return null;
        
        return hash.value[field] || null;
      },
      
      sadd: async (key, ...members) => {
        let set = self.memoryCache.get(key);
        if (!set || !set.isSet) {
          set = { isSet: true, value: new Set() };
        }
        
        let added = 0;
        members.forEach(member => {
          if (!set.value.has(member)) {
            set.value.add(member);
            added++;
          }
        });
        
        self.memoryCache.set(key, set);
        return added;
      },
      
      smembers: async (key) => {
        const set = self.memoryCache.get(key);
        if (!set || !set.isSet) return [];
        
        return Array.from(set.value);
      },
      
      getStats: () => ({ ...self.stats, memoryItems: self.memoryCache.size })
    };
  }

  // Get clients
  getClient() { 
    return this.client; 
  }
  
  getSubscriber() { 
    return this.subscriber; 
  }
  
  getPublisher() { 
    return this.publisher; 
  }
  
  getStatus() { 
    return this.isConnected; 
  }
  
  isFallbackMode() {
    return this.fallbackMode;
  }
  
  getStats() {
    return {
      ...this.stats,
      connected: this.isConnected,
      fallbackMode: this.fallbackMode,
      retryCount: this.retryCount,
      connectionAttempts: this.connectionAttempts,
      memoryItems: this.memoryCache.size
    };
  }

  // Graceful shutdown
  async shutdown() {
    try {
      console.log('🔌 Shutting down Redis connections...');
      
      if (this.healthMonitor) {
        clearInterval(this.healthMonitor);
        console.log('✅ Health monitor stopped');
      }
      
      if (!this.fallbackMode) {
        if (this.publisher && this.publisher.isOpen) {
          await this.publisher.quit();
          console.log('✅ Redis Publisher closed');
        }
        
        if (this.subscriber && this.subscriber.isOpen) {
          await this.subscriber.quit();
          console.log('✅ Redis Subscriber closed');
        }
        
        if (this.client && this.client.isOpen) {
          await this.client.quit();
          console.log('✅ Redis Main client closed');
        }
      } else {
        console.log('⚠️ Fallback mode - cleaning up memory cache');
        this.memoryCache.clear();
      }
      
      this.isConnected = false;
      this.fallbackMode = false;
      
      console.log('✅ Redis shutdown complete');
      this.emit('shutdown');
    } catch (error) {
      console.error('❌ Error during Redis shutdown:', error.message);
    }
  }
}

// Create singleton instance
const redisManager = new RedisManager();

// Export everything
export { redisManager };
export default redisManager;
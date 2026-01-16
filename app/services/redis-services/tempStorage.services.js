// app/services/tempStorage.service.js - COMPLETE FIXED VERSION
import { redisManager } from '../config/redis.js';

class TempStorageService {
  constructor() {
    this.cache = redisManager.getCache();
    this.client = redisManager.getClient();
    this.cleanupInterval = null;
    this.init();
  }

  async init() {
    // Start cleanup scheduler (every 30 minutes instead of hourly)
    this.cleanupInterval = setInterval(() => {
      this.cleanupExpiredData().catch(error => {
        console.warn('⚠️ Auto-cleanup failed:', error.message);
      });
    }, 30 * 60 * 1000); // 30 minutes
    
    // Run initial cleanup after 10 seconds
    setTimeout(() => {
      this.cleanupExpiredData().catch(error => {
        console.warn('⚠️ Initial cleanup failed:', error.message);
      });
    }, 10000);
    
    console.log('✅ Temp Storage Service initialized');
  }

  // ============ OTP MANAGEMENT ============
  async storeOTP(identifier, otp, purpose = 'login', ttl = 300) {
    const key = this.getOTPKey(identifier, purpose);
    
    const otpData = {
      otp,
      identifier,
      purpose,
      attempts: 0,
      maxAttempts: 3,
      createdAt: Date.now(),
      expiresAt: Date.now() + (ttl * 1000),
      verified: false
    };
    
    const success = await this.cache.set(key, otpData, ttl);
    
    if (success) {
      // Store OTP reference using hash
      await this.cache.hset('otp:index', identifier, key, ttl);
    }
    
    return success ? { key, expiresIn: ttl } : null;
  }

  async verifyOTP(identifier, otp, purpose = 'login') {
    const key = this.getOTPKey(identifier, purpose);
    const otpData = await this.cache.get(key);
    
    if (!otpData) {
      return { valid: false, reason: 'OTP_NOT_FOUND' };
    }
    
    // Check attempts
    if (otpData.attempts >= otpData.maxAttempts) {
      return { valid: false, reason: 'MAX_ATTEMPTS_EXCEEDED' };
    }
    
    // Check expiry
    if (Date.now() > otpData.expiresAt) {
      await this.cache.del(key);
      return { valid: false, reason: 'OTP_EXPIRED' };
    }
    
    // Verify OTP
    if (otpData.otp !== otp) {
      // Increment attempts
      otpData.attempts++;
      const remainingTtl = Math.floor((otpData.expiresAt - Date.now()) / 1000);
      
      if (remainingTtl > 0) {
        await this.cache.set(key, otpData, remainingTtl);
      }
      
      const remainingAttempts = otpData.maxAttempts - otpData.attempts;
      
      return {
        valid: false,
        reason: 'OTP_MISMATCH',
        remainingAttempts,
        locked: remainingAttempts <= 0
      };
    }
    
    // OTP is valid
    otpData.verified = true;
    otpData.verifiedAt = Date.now();
    
    // Store verification for 2 minutes
    await this.cache.set(key, otpData, 120);
    
    return {
      valid: true,
      verifiedAt: otpData.verifiedAt,
      identifier: otpData.identifier
    };
  }

  async getOTPInfo(identifier, purpose = 'login') {
    const key = this.getOTPKey(identifier, purpose);
    return await this.cache.get(key);
  }

  async invalidateOTP(identifier, purpose = 'login') {
    const key = this.getOTPKey(identifier, purpose);
    await this.cache.del(key);
    await this.cache.hdel('otp:index', identifier);
    return true;
  }

  getOTPKey(identifier, purpose) {
    return `temp:otp:${purpose}:${identifier}`;
  }

  // ============ PASSWORD RESET TOKENS ============
  async storeResetToken(userId, token, ttl = 3600) {
    const key = `temp:reset:${userId}:${token}`;
    
    const resetData = {
      userId,
      token,
      valid: true,
      createdAt: Date.now(),
      expiresAt: Date.now() + (ttl * 1000),
      used: false
    };
    
    const success = await this.cache.set(key, resetData, ttl);
    
    return success ? token : null;
  }

  async validateResetToken(userId, token) {
    const key = `temp:reset:${userId}:${token}`;
    const resetData = await this.cache.get(key);
    
    if (!resetData) {
      return { valid: false, reason: 'TOKEN_NOT_FOUND' };
    }
    
    if (resetData.used) {
      return { valid: false, reason: 'TOKEN_ALREADY_USED' };
    }
    
    if (Date.now() > resetData.expiresAt) {
      await this.cache.del(key);
      return { valid: false, reason: 'TOKEN_EXPIRED' };
    }
    
    return { valid: true, data: resetData };
  }

  async markResetTokenUsed(userId, token) {
    const key = `temp:reset:${userId}:${token}`;
    const resetData = await this.cache.get(key);
    
    if (resetData) {
      resetData.used = true;
      resetData.usedAt = Date.now();
      const remainingTtl = Math.floor((resetData.expiresAt - Date.now()) / 1000);
      
      if (remainingTtl > 0) {
        await this.cache.set(key, resetData, remainingTtl);
      }
      
      return true;
    }
    
    return false;
  }

  // ============ UPLOAD SESSIONS ============
  async createUploadSession(sessionId, files, userId = null, ttl = 1800) {
    const key = `temp:upload:${sessionId}`;
    
    const sessionData = {
      sessionId,
      userId,
      files: files.map(file => ({
        originalName: file.originalname || file.name,
        size: file.size || 0,
        mimetype: file.mimetype || 'application/octet-stream',
        status: 'pending',
        uploadedAt: null,
        url: null
      })),
      totalFiles: files.length,
      uploadedFiles: 0,
      createdAt: Date.now(),
      expiresAt: Date.now() + (ttl * 1000)
    };
    
    const success = await this.cache.set(key, sessionData, ttl);
    
    return success ? sessionId : null;
  }

  async updateUploadProgress(sessionId, fileIndex, status, url = null) {
    const key = `temp:upload:${sessionId}`;
    const sessionData = await this.cache.get(key);
    
    if (!sessionData) return false;
    
    if (fileIndex >= 0 && fileIndex < sessionData.files.length) {
      sessionData.files[fileIndex].status = status;
      sessionData.files[fileIndex].uploadedAt = status === 'completed' ? Date.now() : null;
      sessionData.files[fileIndex].url = url;
      
      if (status === 'completed') {
        sessionData.uploadedFiles++;
      }
      
      const remainingTtl = Math.floor((sessionData.expiresAt - Date.now()) / 1000);
      
      if (remainingTtl > 0) {
        await this.cache.set(key, sessionData, remainingTtl);
      }
      
      return true;
    }
    
    return false;
  }

  async getUploadSession(sessionId) {
    const key = `temp:upload:${sessionId}`;
    return await this.cache.get(key);
  }

  async completeUploadSession(sessionId) {
    const key = `temp:upload:${sessionId}`;
    const sessionData = await this.cache.get(key);
    
    if (sessionData) {
      sessionData.completed = true;
      sessionData.completedAt = Date.now();
      
      // Keep for 1 hour after completion
      await this.cache.set(key, sessionData, 3600);
      
      return sessionData;
    }
    
    return null;
  }

  // ============ TEMPORARY LINKS ============
  async createTemporaryLink(type, data, ttl = 86400) {
    const token = Math.random().toString(36).substring(2) + Date.now().toString(36);
    const key = `temp:link:${type}:${token}`;
    
    const linkData = {
      token,
      type,
      data,
      createdAt: Date.now(),
      expiresAt: Date.now() + (ttl * 1000),
      clicks: 0,
      maxClicks: type === 'download' ? 1 : 1000,
      valid: true
    };
    
    const success = await this.cache.set(key, linkData, ttl);
    
    return success ? token : null;
  }

  async validateTemporaryLink(type, token) {
    const key = `temp:link:${type}:${token}`;
    const linkData = await this.cache.get(key);
    
    if (!linkData) {
      return { valid: false, reason: 'LINK_NOT_FOUND' };
    }
    
    if (!linkData.valid) {
      return { valid: false, reason: 'LINK_INVALIDATED' };
    }
    
    if (linkData.clicks >= linkData.maxClicks) {
      return { valid: false, reason: 'MAX_CLICKS_EXCEEDED' };
    }
    
    if (Date.now() > linkData.expiresAt) {
      await this.cache.del(key);
      return { valid: false, reason: 'LINK_EXPIRED' };
    }
    
    // Increment click count
    linkData.clicks++;
    const remainingTtl = Math.floor((linkData.expiresAt - Date.now()) / 1000);
    
    if (remainingTtl > 0) {
      await this.cache.set(key, linkData, remainingTtl);
    }
    
    return {
      valid: true,
      data: linkData.data,
      clicks: linkData.clicks,
      maxClicks: linkData.maxClicks
    };
  }

  // ============ RATE LIMITING ============
  async checkRateLimit(key, limit, windowSeconds) {
    const now = Date.now();
    const windowStart = Math.floor(now / 1000 / windowSeconds) * windowSeconds;
    const redisKey = `rate:${key}:${windowStart}`;
    
    const current = await this.cache.incr(redisKey);
    
    if (current === 1) {
      // Set expiry only on first request
      await this.client.expire(redisKey, windowSeconds);
    }
    
    const resetTime = (windowStart + windowSeconds) * 1000;
    
    return {
      allowed: current <= limit,
      limit,
      remaining: Math.max(0, limit - current),
      current,
      reset: resetTime,
      retryAfter: current > limit ? Math.ceil((resetTime - now) / 1000) : 0
    };
  }

  // ============ TEMP DATA STORAGE ============
  async storeTempData(namespace, key, data, ttl = 300) {
    const redisKey = `temp:${namespace}:${key}`;
    return await this.cache.set(redisKey, data, ttl);
  }

  async getTempData(namespace, key) {
    const redisKey = `temp:${namespace}:${key}`;
    return await this.cache.get(redisKey);
  }

  async deleteTempData(namespace, key) {
    const redisKey = `temp:${namespace}:${key}`;
    return await this.cache.del(redisKey);
  }

  async storeBulkTempData(namespace, items, ttl = 600) {
    try {
      const pipeline = this.client.multi();
      
      items.forEach(item => {
        const key = `temp:${namespace}:${item.id}`;
        const value = JSON.stringify(item);
        pipeline.setEx(key, ttl, value);
      });
      
      await pipeline.exec();
      return items.length;
    } catch (error) {
      console.warn('⚠️ Bulk temp storage failed:', error.message);
      return 0;
    }
  }

  // ============ SESSION STORAGE ============
  async storeSessionData(sessionId, data, ttl = 86400) {
    const key = `session:${sessionId}`;
    const sessionData = {
      sessionId,
      data,
      createdAt: Date.now(),
      lastAccessed: Date.now(),
      ttl
    };
    
    return await this.cache.set(key, sessionData, ttl);
  }

  async getSessionData(sessionId, updateAccess = true) {
    const key = `session:${sessionId}`;
    const sessionData = await this.cache.get(key);
    
    if (sessionData && updateAccess) {
      sessionData.lastAccessed = Date.now();
      const remainingTtl = Math.floor((sessionData.createdAt + (sessionData.ttl * 1000) - Date.now()) / 1000);
      
      if (remainingTtl > 0) {
        await this.cache.set(key, sessionData, remainingTtl);
      }
    }
    
    return sessionData?.data || null;
  }

  async deleteSession(sessionId) {
    const key = `session:${sessionId}`;
    return await this.cache.del(key);
  }

  // ============ CLEANUP & MAINTENANCE ============
  async cleanupExpiredData() {
    try {
      console.log('🧹 Starting temp data cleanup...');
      
      const patterns = [
        'temp:otp:*',
        'temp:reset:*',
        'temp:upload:*',
        'temp:link:*',
        'session:*'
      ];
      
      let totalCleaned = 0;
      
      for (const pattern of patterns) {
        try {
          // Use keys with limit for safety
          const keys = await this.cache.keys(pattern);
          
          for (const key of keys) {
            const ttl = await this.cache.ttl(key);
            
            // -2 means key doesn't exist, -1 means no expiry
            if (ttl === -2 || ttl < 60) { // Expired or about to expire
              await this.cache.del(key);
              totalCleaned++;
            }
          }
        } catch (error) {
          console.warn(`⚠️ Cleanup for ${pattern} failed:`, error.message);
        }
      }
      
      // Cleanup OTP index (SIMPLIFIED)
      await this.cleanupOTPIndex();
      
      console.log(`🧹 Cleanup completed: ${totalCleaned} items removed`);
      return totalCleaned;
      
    } catch (error) {
      console.error('❌ Cleanup failed:', error.message);
      return 0;
    }
  }

  // SIMPLIFIED OTP index cleanup - NO SET OPERATIONS
  async cleanupOTPIndex() {
    try {
      const otpIndex = await this.cache.hgetall('otp:index');
      
      if (otpIndex && typeof otpIndex === 'object') {
        let cleaned = 0;
        
        for (const [identifier, key] of Object.entries(otpIndex)) {
          try {
            const exists = await this.cache.exists(key);
            if (!exists) {
              await this.cache.hdel('otp:index', identifier);
              cleaned++;
            }
          } catch (error) {
            console.warn(`⚠️ Failed to check OTP key ${key}:`, error.message);
          }
        }
        
        if (cleaned > 0) {
          console.log(`🧹 Cleaned ${cleaned} expired OTP references`);
        }
      }
    } catch (error) {
      console.warn('⚠️ OTP index cleanup failed:', error.message);
    }
  }

  // ============ STATISTICS ============
  async getStats() {
    const patterns = {
      otp: 'temp:otp:*',
      reset: 'temp:reset:*',
      upload: 'temp:upload:*',
      links: 'temp:link:*',
      sessions: 'session:*'
    };
    
    const stats = {};
    let total = 0;
    
    for (const [type, pattern] of Object.entries(patterns)) {
      try {
        const keys = await this.cache.keys(pattern);
        stats[type] = keys.length;
        total += keys.length;
      } catch (error) {
        stats[type] = 0;
        console.warn(`⚠️ Failed to get stats for ${type}:`, error.message);
      }
    }
    
    stats.total = total;
    stats.timestamp = new Date().toISOString();
    
    return stats;
  }

  // ============ SHUTDOWN ============
  async shutdown() {
    if (this.cleanupInterval) {
      clearInterval(this.cleanupInterval);
      this.cleanupInterval = null;
    }
    
    console.log('✅ Temp Storage Service shutdown');
  }
}

// Create singleton instance
const tempStorageService = new TempStorageService();

// Export for use
export { TempStorageService };
export default tempStorageService;
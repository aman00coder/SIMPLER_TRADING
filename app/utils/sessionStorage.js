// app/utils/sessionStore.js - FIXED REDIS SESSION STORE
import session from 'express-session';

export async function setupRedisSessionStore(redisClient) {
  try {
    console.log('🔄 Setting up Redis session store...');
    
    // Different ways to import connect-redis based on version
    let RedisStore;
    
    try {
      // Method 1: For connect-redis v7+
      const connectRedis = (await import('connect-redis')).default;
      RedisStore = connectRedis(session);
      console.log('✅ Using connect-redis v7+ style');
    } catch (error) {
      console.log('⚠️ Trying alternative import method...');
      
      // Method 2: For older versions
      const connectRedisModule = await import('connect-redis');
      
      if (typeof connectRedisModule === 'function') {
        // connect-redis v4 style
        RedisStore = connectRedisModule(session);
      } else if (connectRedisModule.default) {
        // Default export
        const connectRedis = connectRedisModule.default;
        RedisStore = connectRedis(session);
      } else {
        throw new Error('Could not initialize RedisStore');
      }
    }
    
    if (typeof RedisStore !== 'function') {
      throw new Error('RedisStore is not a constructor');
    }
    
    return new RedisStore({
      client: redisClient,
      prefix: 'sess:',
      ttl: 86400,
      disableTouch: false
    });
    
  } catch (error) {
    console.error('❌ Failed to setup Redis session store:', error.message);
    throw error;
  }
}
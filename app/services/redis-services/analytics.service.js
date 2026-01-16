// app/services/analytics.service.js
import { redisManager } from '../config/redis.js';

class AnalyticsService {
  constructor() {
    this.cache = redisManager.getCache();
    this.client = redisManager.getClient();
    this.metrics = {
      swipes: { total: 0, today: 0 },
      matches: { total: 0, today: 0 },
      users: { active: 0, total: 0 },
      messages: { sent: 0, received: 0 }
    };
    this.init();
  }

  async init() {
    // Load initial metrics from Redis
    await this.loadMetrics();
    
    // Start periodic aggregation
    setInterval(() => this.aggregateHourlyMetrics(), 3600000); // Hourly
    setInterval(() => this.cleanupOldData(), 86400000); // Daily
  }

  async loadMetrics() {
    try {
      this.metrics.swipes.total = parseInt(await this.cache.get('analytics:swipes:total') || 0);
      this.metrics.matches.total = parseInt(await this.cache.get('analytics:matches:total') || 0);
      this.metrics.users.total = parseInt(await this.cache.get('analytics:users:total') || 0);
      
      console.log('📊 Analytics loaded from Redis');
    } catch (error) {
      console.warn('⚠️ Failed to load analytics:', error.message);
    }
  }

  // ============ SWIPE ANALYTICS ============
  async recordSwipe(userId, targetId, direction, latitude = null, longitude = null) {
    const timestamp = Date.now();
    const dateKey = new Date().toISOString().split('T')[0];
    
    // Increment counters
    await this.cache.incr('analytics:swipes:total');
    await this.cache.incr(`analytics:swipes:${dateKey}`);
    await this.cache.incr(`analytics:swipes:user:${userId}:${dateKey}`);
    
    // Store swipe details for real-time analysis
    const swipeData = {
      userId,
      targetId,
      direction, // 'right' or 'left'
      timestamp,
      location: latitude && longitude ? { lat: latitude, lng: longitude } : null,
      source: 'discovery' // or 'recommendation'
    };
    
    // Add to recent swipes list (last 100)
    await this.cache.lpush('analytics:recent:swipes', swipeData, 100);
    
    // Update user's swipe count
    await this.cache.hset(`user:${userId}:stats`, 'swipes', 
      (parseInt(await this.cache.hget(`user:${userId}:stats`, 'swipes') || 0) + 1));
    
    // Update real-time dashboard
    await this.updateRealtimeDashboard();
    
    // Publish real-time update
    await redisManager.getPublisher().publish('analytics:swipes', JSON.stringify({
      type: 'swipe',
      userId,
      direction,
      timestamp
    }));
    
    this.metrics.swipes.total++;
    return swipeData;
  }

  // ============ MATCH ANALYTICS ============
  async recordMatch(user1, user2, matchType = 'direct') {
    const timestamp = Date.now();
    const matchId = `match:${user1}:${user2}:${timestamp}`;
    
    // Increment counters
    await this.cache.incr('analytics:matches:total');
    await this.cache.incr(`analytics:matches:${new Date().toISOString().split('T')[0]}`);
    
    // Store match details
    const matchData = {
      matchId,
      users: [user1, user2],
      type: matchType,
      timestamp,
      conversationStarted: false
    };
    
    await this.cache.set(`match:${matchId}`, matchData, 604800); // 7 days
    
    // Add to user's match history
    await this.cache.lpush(`user:${user1}:matches`, matchId, 50);
    await this.cache.lpush(`user:${user2}:matches`, matchId, 50);
    
    // Update compatibility score (if using ML)
    await this.updateCompatibilityScore(user1, user2);
    
    // Publish real-time match event
    await redisManager.getPublisher().publish('analytics:matches', JSON.stringify({
      type: 'match',
      users: [user1, user2],
      matchId,
      timestamp
    }));
    
    this.metrics.matches.total++;
    return matchData;
  }

// app/services/analytics.service.js - LINE 133 fix

async trackUserActivity(userId, activityType, details = {}) {
  try {
    const timestamp = Date.now();
    const userKey = `user:${userId}:activity`;
    
    const activity = {
      type: activityType,
      timestamp,
      details,
      ip: details.ip || 'unknown',
      userAgent: details.userAgent || 'unknown'
    };
    
    // ✅ FIXED: Use client directly instead of cache.lpush
    const serialized = JSON.stringify(activity);
    
    // Check if client is available
    if (!this.client || !this.client.isReady) {
      console.warn(`⚠️ Redis client not available for activity tracking`);
      return activity;
    }
    
    // Add to activity list
    await this.client.lPush(userKey, serialized);
    
    // Keep only last 1000 activities
    await this.client.lTrim(userKey, 0, 999);
    
    // Update active users set
    await this.client.zAdd('analytics:active:users', {
      score: timestamp,
      value: userId.toString()
    });
    
    // Remove users inactive for 5 minutes
    const fiveMinutesAgo = timestamp - (5 * 60 * 1000);
    await this.client.zRemRangeByScore('analytics:active:users', 0, fiveMinutesAgo);
    
    // Update last seen
    const lastSeenKey = `user:${userId}:lastSeen`;
    await this.client.setEx(lastSeenKey, 86400, timestamp.toString());
    
    console.log(`📝 Activity tracked: ${activityType} for user ${userId}`);
    
    return activity;
  } catch (error) {
    console.warn(`⚠️ Activity tracking failed for ${userId}:`, error.message);
    return null;
  }
}

  // ============ REAL-TIME DASHBOARD ============
  async updateRealtimeDashboard() {
    const now = Date.now();
    const hour = new Date().getHours();
    
    const dashboardData = {
      timestamp: now,
      metrics: {
        activeUsers: await this.getActiveUsersCount(),
        swipesLastHour: await this.getSwipesLastHour(),
        matchesLastHour: await this.getMatchesLastHour(),
        newUsersToday: await this.getNewUsersToday(),
        messagesSent: await this.getMessagesSentToday()
      },
      trends: {
        hourlySwipes: await this.getHourlyTrend('swipes'),
        hourlyMatches: await this.getHourlyTrend('matches'),
        popularTimes: await this.getPopularTimes()
      },
      topPerformers: {
        mostActive: await this.getMostActiveUsers(10),
        mostMatches: await this.getMostMatchesUsers(10),
        mostSwipeRight: await this.getMostRightSwipes(10)
      }
    };
    
    // Cache dashboard with 30-second TTL
    await this.cache.set('dashboard:realtime', dashboardData, 30);
    
    // Publish update to admin clients
    await redisManager.getPublisher().publish('dashboard:updates', JSON.stringify(dashboardData));
    
    return dashboardData;
  }

  // ============ HELPER METHODS ============
async getActiveUsersCount() {
  try {
    const fiveMinutesAgo = Date.now() - (5 * 60 * 1000);
    
    // Use ZCOUNT with scores
    const count = await this.client.zCount(
      'analytics:active:users', 
      fiveMinutesAgo, 
      '+inf'
    );
    
    return count;
  } catch (error) {
    console.warn('⚠️ getActiveUsersCount failed:', error.message);
    return 0;
  }
}

  async getSwipesLastHour() {
    const hourAgo = Date.now() - (60 * 60 * 1000);
    let count = 0;
    
    // Get keys for last hour
    const keys = [];
    for (let i = 0; i < 60; i++) {
      const timeKey = new Date(Date.now() - (i * 60 * 1000)).toISOString().slice(0, 16);
      keys.push(`analytics:swipes:minute:${timeKey}`);
    }
    
    for (const key of keys) {
      const val = await this.cache.get(key);
      count += parseInt(val || 0);
    }
    
    return count;
  }

  async getMatchesLastHour() {
    const hourAgo = Date.now() - (60 * 60 * 1000);
    const matches = await this.client.zCount('analytics:matches:timeline', hourAgo, '+inf');
    return matches;
  }

  async getNewUsersToday() {
    const today = new Date().toISOString().split('T')[0];
    return parseInt(await this.cache.get(`analytics:users:new:${today}`) || 0);
  }

  async getMessagesSentToday() {
    const today = new Date().toISOString().split('T')[0];
    return parseInt(await this.cache.get(`analytics:messages:${today}`) || 0);
  }

  // ============ USER SCORING ============
  async updateUserScore(userId, scoreChange, reason) {
    const currentScore = parseInt(await this.cache.get(`user:${userId}:score`) || 100);
    const newScore = Math.max(0, currentScore + scoreChange);
    
    await this.cache.set(`user:${userId}:score`, newScore, 2592000); // 30 days
    
    // Log score change
    await this.cache.lpush(`user:${userId}:score:history`, {
      timestamp: Date.now(),
      change: scoreChange,
      newScore,
      reason
    }, 100);
    
    return newScore;
  }

  async updateCompatibilityScore(user1, user2) {
    // Simple compatibility calculation
    const score = Math.floor(Math.random() * 100); // Replace with actual ML
    await this.cache.set(`compatibility:${user1}:${user2}`, score, 604800); // 7 days
    return score;
  }

  // ============ AGGREGATION ============
  async aggregateHourlyMetrics() {
    const hour = new Date().getHours();
    const date = new Date().toISOString().split('T')[0];
    const key = `analytics:hourly:${date}:${hour}`;
    
    const metrics = {
      swipes: this.metrics.swipes.total,
      matches: this.metrics.matches.total,
      activeUsers: await this.getActiveUsersCount(),
      timestamp: Date.now()
    };
    
    await this.cache.set(key, metrics, 604800); // Keep for 7 days
    console.log(`📈 Hourly metrics aggregated: ${date} ${hour}:00`);
  }

  async cleanupOldData() {
    const thirtyDaysAgo = Date.now() - (30 * 24 * 60 * 60 * 1000);
    
    // Clean old activity logs
    await this.client.zRemRangeByScore('analytics:active:users', 0, thirtyDaysAgo);
    
    console.log('🧹 Cleaned up old analytics data');
  }

  // ============ REPORTS ============
  async generateDailyReport(date = null) {
    const reportDate = date || new Date().toISOString().split('T')[0];
    
    const report = {
      date: reportDate,
      summary: {
        totalSwipes: await this.cache.get(`analytics:swipes:${reportDate}`) || 0,
        totalMatches: await this.cache.get(`analytics:matches:${reportDate}`) || 0,
        newUsers: await this.cache.get(`analytics:users:new:${reportDate}`) || 0,
        activeUsers: await this.getActiveUsersCount()
      },
      hourlyBreakdown: [],
      topUsers: await this.getMostActiveUsers(20),
      conversionRate: 0
    };
    
    // Calculate conversion rate
    const swipes = report.summary.totalSwipes;
    const matches = report.summary.totalMatches;
    report.summary.conversionRate = swipes > 0 ? ((matches / swipes) * 100).toFixed(2) : 0;
    
    // Get hourly data
    for (let hour = 0; hour < 24; hour++) {
      const hourlyKey = `analytics:hourly:${reportDate}:${hour}`;
      const data = await this.cache.get(hourlyKey);
      if (data) {
        report.hourlyBreakdown.push({ hour, ...data });
      }
    }
    
    // Cache report
    await this.cache.set(`report:daily:${reportDate}`, report, 2592000); // 30 days
    
    return report;
  }

  // ============ ADMIN METHODS ============
  async getSystemHealth() {
    return {
      redis: await redisManager.healthCheck(),
      metrics: this.metrics,
      uptime: process.uptime(),
      memory: process.memoryUsage(),
      timestamp: new Date().toISOString()
    };
  }

  async resetMetrics() {
    // Reset only temporary metrics, keep historical data
    this.metrics.swipes.today = 0;
    this.metrics.matches.today = 0;
    
    console.log('📊 Daily metrics reset');
  }

  // ============ TREND ANALYSIS ============
  async getHourlyTrend(metric) {
    const trends = [];
    const now = new Date();
    
    for (let i = 23; i >= 0; i--) {
      const hour = new Date(now.getTime() - (i * 60 * 60 * 1000));
      const key = `analytics:${metric}:${hour.toISOString().split('T')[0]}:${hour.getHours()}`;
      const value = await this.cache.get(key) || 0;
      trends.push({
        hour: hour.getHours(),
        value: parseInt(value)
      });
    }
    
    return trends;
  }

  async getPopularTimes() {
    const popular = {
      swipes: {},
      matches: {}
    };
    
    // Analyze last 7 days
    for (let day = 0; day < 7; day++) {
      const date = new Date(Date.now() - (day * 24 * 60 * 60 * 1000));
      const dateStr = date.toISOString().split('T')[0];
      
      for (let hour = 0; hour < 24; hour++) {
        const key = `analytics:swipes:${dateStr}:${hour}`;
        const swipes = parseInt(await this.cache.get(key) || 0);
        
        if (!popular.swipes[hour]) popular.swipes[hour] = 0;
        popular.swipes[hour] += swipes;
      }
    }
    
    return popular;
  }

  async getMostActiveUsers(limit = 10) {
    // Get users with most activity in last 24 hours
    const activeKey = 'analytics:active:users';
    const dayAgo = Date.now() - (24 * 60 * 60 * 1000);
    
    const users = await this.client.zRangeByScoreWithScores(activeKey, dayAgo, '+inf');
    
    return users
      .sort((a, b) => b.score - a.score)
      .slice(0, limit)
      .map(user => ({
        userId: user.value,
        score: user.score,
        lastActive: new Date(parseInt(user.score))
      }));
  }

  async getMostMatchesUsers(limit = 10) {
    // This would require storing match counts per user
    // For now, return empty
    return [];
  }

  async getMostRightSwipes(limit = 10) {
    // This would require storing right swipe counts
    // For now, return empty
    return [];
  }
}

// Create singleton instance
const analyticsService = new AnalyticsService();

// Export for use
export { AnalyticsService };
export default analyticsService;
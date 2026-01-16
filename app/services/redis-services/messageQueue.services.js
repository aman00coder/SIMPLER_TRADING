// app/services/messageQueue.service.js - COMPLETE FIXED VERSION
import { redisManager } from '../config/redis.js';
import { EventEmitter } from 'events';

class MessageQueueService extends EventEmitter {
  constructor() {
    super();
    this.client = null;
    this.subscriber = null;
    this.publisher = null;
    this.queues = new Map();
    this.workers = new Map();
    this.maxRetries = 3;
    this.initialized = false;
    
    // Standard channels
    this.channels = {
      NOTIFICATIONS: 'channel:notifications',
      MATCHES: 'channel:matches',
      MESSAGES: 'channel:messages',
      EVENTS: 'channel:events',
      SYSTEM: 'channel:system'
    };
  }

  async initialize() {
    if (this.initialized) return;
    
    try {
      console.log('🔄 Initializing Message Queue Service...');
      
      // Get Redis clients
      this.client = redisManager.getClient();
      this.subscriber = redisManager.getSubscriber();
      this.publisher = redisManager.getPublisher();
      
      // Wait for Redis to be ready
      if (!this.subscriber || !this.subscriber.isReady) {
        console.log('⏳ Waiting for Redis subscriber...');
        await new Promise(resolve => setTimeout(resolve, 2000));
        
        // Re-get clients
        this.client = redisManager.getClient();
        this.subscriber = redisManager.getSubscriber();
        this.publisher = redisManager.getPublisher();
        
        if (!this.subscriber || !this.subscriber.isReady) {
          console.warn('⚠️ Redis subscriber still not ready');
          return;
        }
      }
      
      // FIRST create queues
      console.log('📦 Creating queues...');
      await this.setupTinderQueues();
      
      // THEN subscribe to channels
      console.log('📡 Subscribing to channels...');
      await this.subscribeToChannels();
      
      // FINALLY start processors
      console.log('⚙️ Starting queue processors...');
      await this.startQueueProcessors();
      
      this.initialized = true;
      console.log('✅ Message Queue Service initialized successfully');
    } catch (error) {
      console.error('❌ Failed to initialize Message Queue:', error.message);
      console.log('⚠️ Message Queue running in degraded mode');
      this.initialized = false;
    }
  }

  async subscribeToChannels() {
    try {
      await this.subscriber.subscribe(Object.values(this.channels), (message, channel) => {
        this.handleMessage(message, channel);
      });
    } catch (error) {
      console.error('❌ Failed to subscribe to channels:', error.message);
      throw error;
    }
  }

  // ============ PUB/SUB METHODS ============
  async publish(channel, message, metadata = {}) {
    try {
      if (!this.publisher || !this.publisher.isReady) {
        throw new Error('Redis publisher not available');
      }
      
      const payload = {
        id: `msg_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`,
        channel,
        data: message,
        metadata: {
          ...metadata,
          timestamp: Date.now(),
          publisher: 'message-queue-service'
        }
      };
      
      await this.publisher.publish(channel, JSON.stringify(payload));
      
      // Emit local event
      this.emit('published', payload);
      
      return payload.id;
    } catch (error) {
      console.error(`❌ Failed to publish to ${channel}:`, error.message);
      throw error;
    }
  }

  async subscribe(channel, callback) {
    try {
      if (!this.subscriber || !this.subscriber.isReady) {
        throw new Error('Redis subscriber not available');
      }
      
      await this.subscriber.subscribe(channel, (message) => {
        try {
          const parsed = JSON.parse(message);
          callback(parsed.data, parsed.metadata);
        } catch (e) {
          callback(message, {});
        }
      });
      
      console.log(`✅ Subscribed to channel: ${channel}`);
    } catch (error) {
      console.error(`❌ Failed to subscribe to ${channel}:`, error.message);
      throw error;
    }
  }

  async unsubscribe(channel) {
    try {
      if (!this.subscriber || !this.subscriber.isReady) {
        return;
      }
      
      await this.subscriber.unsubscribe(channel);
      console.log(`✅ Unsubscribed from channel: ${channel}`);
    } catch (error) {
      console.error(`❌ Failed to unsubscribe from ${channel}:`, error.message);
    }
  }

  handleMessage(message, channel) {
    try {
      const parsed = JSON.parse(message);
      
      // Emit event for local listeners
      this.emit(`channel:${channel}`, parsed.data, parsed.metadata);
      this.emit('message', { channel, data: parsed.data, metadata: parsed.metadata });
      
      // Log message (optional)
      if (process.env.NODE_ENV === 'development') {
        console.log(`📨 [${channel}] Received:`, parsed.data.type || 'message');
      }
    } catch (error) {
      console.error(`❌ Failed to parse message on ${channel}:`, error.message);
    }
  }

  // ============ QUEUE METHODS ============
  async createQueue(queueName, options = {}) {
    if (!this.client || !this.client.isReady) {
      console.warn(`⚠️ Cannot create queue ${queueName}: Redis client not ready`);
      return null;
    }
    
    const queueConfig = {
      maxRetries: options.maxRetries || this.maxRetries,
      timeout: options.timeout || 30000,
      concurrency: options.concurrency || 1,
      ...options
    };
    
    this.queues.set(queueName, queueConfig);
    
    try {
      // Initialize metrics - Use object directly
      const metricsKey = `queue:${queueName}:metrics`;
      await this.client.hSet(metricsKey, [
        'total', '0',
        'processed', '0', 
        'failed', '0',
        'delayed', '0',
        'active', '0'
      ]);
      
      console.log(`✅ Queue created: ${queueName}`);
      return queueConfig;
    } catch (error) {
      console.error(`❌ Failed to create queue ${queueName}:`, error.message);
      return null;
    }
  }

  async addJob(queueName, jobData, options = {}) {
    const queue = this.queues.get(queueName);
    if (!queue) {
      throw new Error(`Queue ${queueName} not found`);
    }
    
    if (!this.client || !this.client.isReady) {
      throw new Error('Redis client not available');
    }
    
    const jobId = `job_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
    const job = {
      id: jobId,
      queue: queueName,
      data: jobData,
      status: 'pending',
      attempts: 0,
      maxAttempts: options.maxAttempts || queue.maxRetries,
      created: Date.now(),
      delay: options.delay || 0,
      priority: options.priority || 0,
      timeout: options.timeout || queue.timeout,
      metadata: options.metadata || {}
    };
    
    try {
      if (job.delay > 0) {
        // Add to delayed sorted set
        const delayedKey = `queue:${queueName}:delayed`;
        await this.client.zAdd(delayedKey, {
          score: Date.now() + (job.delay * 1000),
          value: JSON.stringify(job)
        });
        
        // Update metrics
        await this.client.hIncrBy(`queue:${queueName}:metrics`, 'delayed', 1);
      } else {
        // Add to immediate queue
        const queueKey = `queue:${queueName}`;
        const priorityScore = Date.now() - (job.priority * 1000);
        
        await this.client.zAdd(queueKey, {
          score: priorityScore,
          value: JSON.stringify(job)
        });
      }
      
      // Update total jobs count
      await this.client.hIncrBy(`queue:${queueName}:metrics`, 'total', 1);
      
      // Publish job added event
      await this.publish(this.channels.SYSTEM, {
        type: 'job_added',
        queue: queueName,
        jobId,
        timestamp: Date.now()
      });
      
      console.log(`✅ Job added to ${queueName}: ${jobId}`);
      return jobId;
    } catch (error) {
      console.error(`❌ Failed to add job to ${queueName}:`, error.message);
      throw error;
    }
  }

  async processQueue(queueName, processor) {
    const queue = this.queues.get(queueName);
    if (!queue) {
      throw new Error(`Queue ${queueName} not found`);
    }
    
    if (this.workers.has(queueName)) {
      console.warn(`⚠️ Queue ${queueName} already has a worker`);
      return;
    }
    
    const worker = {
      active: true,
      processing: false,
      concurrency: queue.concurrency,
      currentJobs: new Set()
    };
    
    this.workers.set(queueName, worker);
    
    // Start processing in background
    this.startQueueWorker(queueName, processor).catch(error => {
      console.error(`❌ Queue worker ${queueName} failed:`, error.message);
    });
    
    console.log(`✅ Worker started for queue: ${queueName}`);
  }

  async startQueueWorker(queueName, processor) {
    const worker = this.workers.get(queueName);
    if (!worker) return;
    
    while (worker.active) {
      if (worker.currentJobs.size >= worker.concurrency) {
        await new Promise(resolve => setTimeout(resolve, 100));
        continue;
      }
      
      try {
        if (!this.client || !this.client.isReady) {
          await new Promise(resolve => setTimeout(resolve, 1000));
          continue;
        }
        
        // Check delayed jobs first
        const delayedKey = `queue:${queueName}:delayed`;
        const now = Date.now();
        
        const delayedJobs = await this.client.zRangeByScore(delayedKey, 0, now, {
          LIMIT: { offset: 0, count: 1 }
        });
        
        if (delayedJobs.length > 0) {
          // Move delayed job to main queue
          const job = JSON.parse(delayedJobs[0]);
          await this.client.zRem(delayedKey, delayedJobs[0]);
          
          const queueKey = `queue:${queueName}`;
          const priorityScore = Date.now() - (job.priority * 1000);
          
          await this.client.zAdd(queueKey, {
            score: priorityScore,
            value: JSON.stringify(job)
          });
          
          await this.client.hIncrBy(`queue:${queueName}:metrics`, 'delayed', -1);
        }
        
        // Get next job from queue
        const queueKey = `queue:${queueName}`;
        const jobs = await this.client.zRange(queueKey, 0, 0);
        
        if (jobs.length === 0) {
          await new Promise(resolve => setTimeout(resolve, 1000));
          continue;
        }
        
        const job = JSON.parse(jobs[0]);
        
        // Remove from queue and add to active
        await this.client.zRem(queueKey, jobs[0]);
        
        const activeKey = `queue:${queueName}:active`;
        await this.client.zAdd(activeKey, {
          score: Date.now() + (job.timeout || 30000),
          value: JSON.stringify(job)
        });
        
        await this.client.hIncrBy(`queue:${queueName}:metrics`, 'active', 1);
        
        // Process job
        worker.currentJobs.add(job.id);
        this.processJob(queueName, job, processor);
        
      } catch (error) {
        console.error(`❌ Error in queue worker ${queueName}:`, error.message);
        await new Promise(resolve => setTimeout(resolve, 5000));
      }
    }
  }

  async processJob(queueName, job, processor) {
    const worker = this.workers.get(queueName);
    const startTime = Date.now();
    
    try {
      // Update job status
      job.status = 'processing';
      job.started = startTime;
      job.attempts++;
      
      // Process the job
      const result = await Promise.race([
        processor(job.data, job),
        new Promise((_, reject) => 
          setTimeout(() => reject(new Error('Job timeout')), job.timeout)
        )
      ]);
      
      // Job successful
      job.status = 'completed';
      job.completed = Date.now();
      job.duration = job.completed - startTime;
      job.result = result;
      
      // Remove from active
      const activeKey = `queue:${queueName}:active`;
      await this.client.zRem(activeKey, JSON.stringify(job));
      
      // Update metrics
      await this.client.hIncrBy(`queue:${queueName}:metrics`, 'processed', 1);
      await this.client.hIncrBy(`queue:${queueName}:metrics`, 'active', -1);
      
      // Publish completion
      await this.publish(this.channels.SYSTEM, {
        type: 'job_completed',
        queue: queueName,
        jobId: job.id,
        duration: job.duration,
        timestamp: Date.now()
      });
      
      console.log(`✅ Job completed: ${job.id} in ${job.duration}ms`);
      
    } catch (error) {
      // Job failed
      job.status = 'failed';
      job.error = error.message;
      job.completed = Date.now();
      job.duration = job.completed - startTime;
      
      // Check if should retry
      if (job.attempts < job.maxAttempts) {
        // Requeue with delay
        const retryDelay = Math.min(30000, Math.pow(2, job.attempts) * 1000);
        
        job.status = 'retrying';
        job.retryAt = Date.now() + retryDelay;
        
        // Add to delayed for retry
        const delayedKey = `queue:${queueName}:delayed`;
        await this.client.zAdd(delayedKey, {
          score: job.retryAt,
          value: JSON.stringify(job)
        });
        
        console.log(`🔄 Job ${job.id} scheduled for retry in ${retryDelay}ms (attempt ${job.attempts}/${job.maxAttempts})`);
        
      } else {
        // Move to failed queue
        const failedKey = `queue:${queueName}:failed`;
        await this.client.lPush(failedKey, JSON.stringify(job));
        
        // Update metrics
        await this.client.hIncrBy(`queue:${queueName}:metrics`, 'failed', 1);
        
        console.error(`❌ Job failed permanently: ${job.id}`, error.message);
        
        // Publish failure
        await this.publish(this.channels.SYSTEM, {
          type: 'job_failed',
          queue: queueName,
          jobId: job.id,
          error: error.message,
          attempts: job.attempts,
          timestamp: Date.now()
        });
      }
      
      // Remove from active
      const activeKey = `queue:${queueName}:active`;
      await this.client.zRem(activeKey, JSON.stringify(job));
      await this.client.hIncrBy(`queue:${queueName}:metrics`, 'active', -1);
      
    } finally {
      // Clean up
      if (worker) {
        worker.currentJobs.delete(job.id);
      }
    }
  }

  // ============ SPECIFIC QUEUES FOR TINDER ============
  async setupTinderQueues() {
    try {
      console.log('📦 Setting up Tinder queues...');
      
      // Check Redis client
      if (!this.client || !this.client.isReady) {
        console.warn('⚠️ Redis client not ready, skipping queue setup');
        return;
      }
      
      // 1. Email Queue
      await this.createQueue('emails', {
        maxRetries: 3,
        concurrency: 5,
        timeout: 30000
      });
      
      // 2. Notification Queue
      await this.createQueue('notifications', {
        maxRetries: 2,
        concurrency: 10,
        timeout: 15000
      });
      
      // 3. Image Processing Queue
      await this.createQueue('images', {
        maxRetries: 1,
        concurrency: 3,
        timeout: 60000
      });
      
      // 4. Match Processing Queue
      await this.createQueue('matches', {
        maxRetries: 2,
        concurrency: 5,
        timeout: 20000
      });
      
      // 5. Analytics Queue
      await this.createQueue('analytics', {
        maxRetries: 1,
        concurrency: 2,
        timeout: 45000
      });
      
      console.log('✅ Tinder queues setup complete');
    } catch (error) {
      console.error('❌ Failed to setup Tinder queues:', error.message);
      throw error;
    }
  }

  // ============ QUEUE MANAGEMENT ============
  async getQueueStats(queueName) {
    try {
      if (!this.client || !this.client.isReady) {
        return null;
      }
      
      const metrics = await this.client.hGetAll(`queue:${queueName}:metrics`);
      
      // Get queue lengths
      const pending = await this.client.zCard(`queue:${queueName}`);
      const delayed = await this.client.zCard(`queue:${queueName}:delayed`);
      const active = await this.client.zCard(`queue:${queueName}:active`);
      const failed = await this.client.lLen(`queue:${queueName}:failed`);
      
      return {
        name: queueName,
        metrics: {
          total: parseInt(metrics.total || 0),
          processed: parseInt(metrics.processed || 0),
          failed: parseInt(metrics.failed || 0),
          delayed: parseInt(metrics.delayed || 0),
          active: parseInt(metrics.active || 0)
        },
        current: {
          pending,
          delayed,
          active,
          failed
        },
        worker: this.workers.has(queueName) ? 'active' : 'inactive',
        timestamp: new Date().toISOString()
      };
    } catch (error) {
      console.error(`❌ Failed to get stats for ${queueName}:`, error.message);
      return null;
    }
  }

  async getAllQueuesStats() {
    const stats = {};
    
    for (const [queueName] of this.queues) {
      stats[queueName] = await this.getQueueStats(queueName);
    }
    
    return stats;
  }

  async pauseQueue(queueName) {
    const worker = this.workers.get(queueName);
    if (worker) {
      worker.active = false;
      this.workers.delete(queueName);
      console.log(`⏸️ Queue paused: ${queueName}`);
    }
  }

  async resumeQueue(queueName) {
    if (!this.workers.has(queueName)) {
      console.log(`⚠️ Cannot resume ${queueName} without processor. Use processQueue() instead.`);
    }
  }

  async retryFailedJobs(queueName, count = 10) {
    if (!this.client || !this.client.isReady) {
      throw new Error('Redis client not available');
    }
    
    const failedKey = `queue:${queueName}:failed`;
    
    for (let i = 0; i < count; i++) {
      const jobStr = await this.client.rPop(failedKey);
      if (!jobStr) break;
      
      const job = JSON.parse(jobStr);
      job.status = 'pending';
      job.attempts = 0;
      job.error = undefined;
      
      // Re-add to queue
      const queueKey = `queue:${queueName}`;
      const priorityScore = Date.now() - (job.priority * 1000);
      
      await this.client.zAdd(queueKey, {
        score: priorityScore,
        value: JSON.stringify(job)
      });
      
      console.log(`🔄 Retrying failed job: ${job.id}`);
    }
  }

  async purgeQueue(queueName) {
    if (!this.client || !this.client.isReady) {
      throw new Error('Redis client not available');
    }
    
    const keys = [
      `queue:${queueName}`,
      `queue:${queueName}:delayed`,
      `queue:${queueName}:active`,
      `queue:${queueName}:failed`,
      `queue:${queueName}:metrics`
    ];
    
    await this.client.del(keys);
    console.log(`🧹 Queue purged: ${queueName}`);
  }

  // ============ TINDER-SPECIFIC METHODS ============
  async sendNotification(userId, notification) {
    const jobData = {
      type: 'notification',
      userId,
      notification,
      timestamp: Date.now()
    };
    
    return await this.addJob('notifications', jobData, {
      priority: 1,
      metadata: { channel: 'push' }
    });
  }

  async processMatch(matchData) {
    const jobData = {
      type: 'match_processing',
      matchData,
      timestamp: Date.now()
    };
    
    return await this.addJob('matches', jobData, {
      priority: 2,
      metadata: { urgent: true }
    });
  }

  async sendWelcomeEmail(userId) {
    const jobData = {
      type: 'welcome_email',
      userId,
      timestamp: Date.now()
    };
    
    return await this.addJob('emails', jobData, {
      delay: 60, // Send after 1 minute
      priority: 0
    });
  }

  // ============ STARTUP ============
  async startQueueProcessors() {
    const queues = ['emails', 'notifications', 'images', 'matches', 'analytics'];
    
    for (const queueName of queues) {
      if (!this.queues.has(queueName)) {
        console.warn(`⚠️ Queue ${queueName} not found, skipping processor`);
        continue;
      }
      
      try {
        await this.processQueue(queueName, async (data) => {
          console.log(`⚙️ Processing ${queueName} job:`, data.type || 'job');
          // Add actual processing logic here
          await new Promise(resolve => setTimeout(resolve, 100));
          return { processed: true, queue: queueName };
        });
      } catch (error) {
        console.error(`❌ Failed to start processor for ${queueName}:`, error.message);
      }
    }
    
    console.log('✅ All queue processors started');
  }

  // ============ SHUTDOWN ============
  async shutdown() {
    console.log('🔌 Shutting down Message Queue Service...');
    
    // Stop all workers
    for (const [queueName, worker] of this.workers) {
      worker.active = false;
    }
    this.workers.clear();
    
    // Unsubscribe from channels
    try {
      if (this.subscriber && this.subscriber.isReady) {
        await this.subscriber.unsubscribe();
      }
    } catch (error) {
      console.error('❌ Error unsubscribing:', error.message);
    }
    
    this.initialized = false;
    console.log('✅ Message Queue Service shutdown complete');
  }
}

// Create singleton instance
const messageQueueService = new MessageQueueService();

// Export for use
export { MessageQueueService };
export default messageQueueService;
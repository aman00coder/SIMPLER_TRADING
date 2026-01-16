// test-redis.js
import net from 'net';

const testRedisConnection = () => {
  return new Promise((resolve) => {
    const socket = new net.Socket();
    socket.setTimeout(5000);
    
    socket.on('connect', () => {
      console.log(`✅ TCP connection successful to Redis Cloud`);
      socket.destroy();
      resolve(true);
    });
    
    socket.on('timeout', () => {
      console.log(`❌ Connection timeout`);
      socket.destroy();
      resolve(false);
    });
    
    socket.on('error', (err) => {
      console.log(`❌ Connection error: ${err.message}`);
      socket.destroy();
      resolve(false);
    });
    
    socket.connect(18515, 'redis-18515.crce182.ap-south-1-1.ec2.cloud.redislabs.com');
  });
};

testRedisConnection();
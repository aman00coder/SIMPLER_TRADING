// import AWS from 'aws-sdk';
// import multer from 'multer';
// import dotenv from 'dotenv';

// dotenv.config();

// // Environment Variables Check
// const requiredEnvVars = [
//     "AWS_ACCESS_KEY_ID",
//     "AWS_SECRET_ACCESS_KEY",
//     "AWS_REGION",
//     "AWS_S3_BUCKET_NAME"
// ];

// requiredEnvVars.forEach((key) => {
//     if (!process.env[key]) {
//         throw new Error(`❌ Missing environment variable: ${key}`);
//     }
// });

// // AWS S3 Configuration
// const s3 = new AWS.S3({
//     accessKeyId: process.env.AWS_ACCESS_KEY_ID,
//     secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY,
//     region: process.env.AWS_REGION,
//     signatureVersion: 'v4'
// });

// // Multer Storage
// const storage = multer.memoryStorage();
// const upload = multer({ storage });

// // Function to sanitize file name
// const sanitizeFileName = (fileName) => {
//     return fileName.replace(/\s+/g, '_').replace(/[^\w.-]/g, '');
// };

// // Upload File to S3
// export const uploadToS3 = async (file, apiFolder = '') => {
//     const bucketName = process.env.AWS_S3_BUCKET_NAME;
//     const sanitizedFileName = sanitizeFileName(file.originalname);
//     const fileKey = apiFolder ? `${apiFolder}/${Date.now()}_${sanitizedFileName}` : `${Date.now()}_${sanitizedFileName}`;

//     try {
//         const params = {
//             Bucket: bucketName,
//             Key: fileKey,
//             Body: file.buffer,
//             ContentType: file.mimetype
//         };

//         await s3.upload(params).promise();
//         const fileUrl = `https://${bucketName}.s3.${process.env.AWS_REGION}.amazonaws.com/${fileKey}`;

//         console.log(`✅ [UPLOAD SUCCESS] File Uploaded: ${fileUrl}`);
//         return fileUrl;
//     } catch (error) {
//         console.error(`❌ [ERROR] Upload Failed: ${error.message}`);
//         throw new Error('File upload failed');
//     }
// };

// // Delete File from S3
// export const deleteFileFromS3 = async (fileUrl) => {
//     const bucketName = process.env.AWS_S3_BUCKET_NAME;

//     try {
//         if (!fileUrl || typeof fileUrl !== 'string' || !fileUrl.startsWith('http')) {
//             console.error('❌ [ERROR] Invalid or missing fileUrl:', fileUrl);
//             return;
//         }

//         const url = new URL(fileUrl);
//         const fileKey = decodeURIComponent(url.pathname.slice(1)); // Removes leading "/"

//         if (!fileKey) {
//             console.error('❌ [ERROR] File key extraction failed.');
//             return;
//         }

//         const deleteParams = { Bucket: bucketName, Key: fileKey };

//         await s3.deleteObject(deleteParams).promise();
//         console.log(`✅ [DELETE SUCCESS] File deleted from S3: ${fileKey}`);
//     } catch (error) {
//         console.error(`❌ [ERROR] Failed to delete file from S3: ${error.message}`);
//         throw new Error('File delete failed');
//     }
// };

// // File Upload Middleware with detailed file info
// // export const uploadFile = (fields) => {
// //     return (req, res, next) => {
// //         const uploadMiddleware = upload.fields(fields);

// //         uploadMiddleware(req, res, async (err) => {
// //             if (err) {
// //                 console.error('❌ [ERROR] File upload failed:', err.message);
// //                 return res.status(400).json({ message: '❌ File upload failed', error: err.message });
// //             }

// //             console.log("📂 [DEBUG] req.files:", req.files);
// //             console.log("📋 [DEBUG] req.body:", req.body);

// //             if (!req.files) {
// //                 return res.status(400).json({ message: '❌ No files uploaded' });
// //             }

// //             const fileUrls = {};
// //             const uploadedFiles = [];
// //             const folderName = ''; // agar chahiye to yahan folder name daal sakte ho

// //             try {
// //                 for (const field of fields) {
// //                     if (req.files[field.name]?.length > 0) {
// //                         const uploadedFileObjs = [];

// //                         for (const file of req.files[field.name]) {
// //                             const uploadedFileUrl = await uploadToS3(file, folderName);

// //                             uploadedFileObjs.push({
// //                                 fileName: file.originalname,
// //                                 fileUrl: uploadedFileUrl,
// //                                 fileType: file.mimetype,
// //                                 uploadedBy: req.user?._id || null, // Agar authentication middleware hai to id milegi
// //                                 uploadedAt: new Date()
// //                             });

// //                             uploadedFiles.push(uploadedFileUrl);
// //                         }

// //                         fileUrls[field.name] = uploadedFileObjs;
// //                     } else {
// //                         // Agar koi existing files update karna ho to wo body me bheja gaya hoga
// //                         fileUrls[field.name] = req.body[`existing_${field.name}`] || [];
// //                     }
// //                 }

// //                 // req.body me file info merge kar do
// //                 req.body = { ...req.body, ...fileUrls };
// //                 next();

// //             } catch (error) {
// //                 console.error('❌ [ERROR] Middleware file handling failed:', error.message);

// //                 // Agar upload ke beech error aaya, to uploaded files delete kar do
// //                 for (const fileUrl of uploadedFiles) {
// //                     await deleteFileFromS3(fileUrl);
// //                 }

// //                 return res.status(500).json({ message: '❌ File upload error', error: error.message });
// //             }
// //         });
// //     };
// // };


// // middleware में console.log जोड़ें:
// export const uploadFile = (fields) => {
//     return (req, res, next) => {
//         const uploadMiddleware = upload.fields(fields);

//         uploadMiddleware(req, res, async (err) => {
//             if (err) {
//                 console.error('❌ [ERROR] File upload failed:', err.message);
//                 return res.status(400).json({ message: '❌ File upload failed', error: err.message });
//             }

//             console.log("📂 [DEBUG] req.files (multer के बाद):", req.files);
//             console.log("📋 [DEBUG] req.body (multer के बाद):", req.body);

//             if (!req.files) {
//                 return res.status(400).json({ message: '❌ No files uploaded' });
//             }

//             const fileUrls = {};
//             const uploadedFiles = [];
//             const folderName = 'lectures'; // अलग folder बना दें lectures के लिए

//             try {
//                 for (const field of fields) {
//                     if (req.files[field.name]?.length > 0) {
//                         const uploadedFileObjs = [];

//                         for (const file of req.files[field.name]) {
//                             console.log(`📁 [PROCESSING] Uploading file: ${file.originalname}`);
//                             const uploadedFileUrl = await uploadToS3(file, folderName);
                            
//                             console.log(`✅ [UPLOADED] File URL: ${uploadedFileUrl}`);

//                             uploadedFileObjs.push({
//                                 fileName: file.originalname,
//                                 fileUrl: uploadedFileUrl,
//                                 fileType: file.mimetype,
//                                 uploadedBy: req.user?._id || req.tokenData?.userId || null,
//                                 uploadedAt: new Date()
//                             });

//                             uploadedFiles.push(uploadedFileUrl);
//                         }

//                         // यहाँ महत्वपूर्ण है - सीधे object assign करें
//                         fileUrls[field.name] = uploadedFileObjs;
//                     } else {
//                         console.log(`⚠️ [INFO] No new files for field: ${field.name}`);
//                     }
//                 }

//                 console.log("📦 [FINAL] fileUrls object:", JSON.stringify(fileUrls, null, 2));
                
//                 // req.body में merge करने के बजाय, सीधे req.fileUrls में assign करें
//                 req.fileUrls = fileUrls;
                
//                 // req.body में भी assign करें बैकअप के लिए
//                 Object.assign(req.body, fileUrls);
                
//                 console.log("✅ [MIDDLEWARE] Upload completed successfully");
//                 console.log("📦 [req.fileUrls]:", req.fileUrls);
//                 console.log("📋 [req.body after merge]:", req.body);
                
//                 next();

//             } catch (error) {
//                 console.error('❌ [ERROR] Middleware file handling failed:', error.message);

//                 // Rollback uploaded files
//                 for (const fileUrl of uploadedFiles) {
//                     await deleteFileFromS3(fileUrl);
//                 }

//                 return res.status(500).json({ message: '❌ File upload error', error: error.message });
//             }
//         });
//     };
// };







// import AWS from 'aws-sdk';
// import multer from 'multer';
// import dotenv from 'dotenv';
// import path from 'path';
// import fs from 'fs/promises';
// import { v4 as uuidv4 } from 'uuid';

// dotenv.config();

// // Environment Variables Check with detailed error messages
// const requiredEnvVars = [
//     { key: "AWS_ACCESS_KEY_ID", description: "AWS Access Key ID for S3 access" },
//     { key: "AWS_SECRET_ACCESS_KEY", description: "AWS Secret Access Key for S3 access" },
//     { key: "AWS_REGION", description: "AWS Region where S3 bucket is located" },
//     { key: "AWS_S3_BUCKET_NAME", description: "S3 Bucket name for file storage" }
// ];

// requiredEnvVars.forEach(({ key, description }) => {
//     if (!process.env[key]) {
//         console.error(`❌ [ENV ERROR] Missing environment variable: ${key}`);
//         console.error(`   Description: ${description}`);
//         throw new Error(`Missing required environment variable: ${key}`);
//     }
// });

// // AWS S3 Configuration with enhanced settings
// AWS.config.update({
//     maxRetries: 3,
//     httpOptions: {
//         timeout: 300000, // 5 minutes timeout for large uploads
//         connectTimeout: 10000
//     }
// });

// const s3 = new AWS.S3({
//     accessKeyId: process.env.AWS_ACCESS_KEY_ID,
//     secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY,
//     region: process.env.AWS_REGION,
//     signatureVersion: 'v4',
//     s3ForcePathStyle: false,
//     logger: console
// });

// // Multer Storage Configuration
// const storage = multer.memoryStorage();

// // Enhanced video file filter with detailed logging
// const createFileFilter = (allowedMimeTypes, allowedExtensions, fieldName) => {
//     return (req, file, cb) => {
//         const fileExtension = path.extname(file.originalname).toLowerCase().slice(1);
        
//         console.log(`📁 [FILE FILTER] Checking file: ${file.originalname}`);
//         console.log(`   - MIME Type: ${file.mimetype}`);
//         console.log(`   - Extension: ${fileExtension}`);
//         console.log(`   - Field Name: ${fieldName}`);
//         console.log(`   - Size: ${(file.size / (1024 * 1024)).toFixed(2)} MB`);

//         // Check MIME type
//         if (allowedMimeTypes && !allowedMimeTypes.includes(file.mimetype)) {
//             console.log(`❌ [REJECTED] Invalid MIME type: ${file.mimetype}`);
//             return cb(new Error(
//                 `Invalid file type for ${fieldName}. Allowed MIME types: ${allowedMimeTypes.join(', ')}`
//             ), false);
//         }

//         // Check file extension
//         if (allowedExtensions && !allowedExtensions.includes(fileExtension)) {
//             console.log(`❌ [REJECTED] Invalid file extension: ${fileExtension}`);
//             return cb(new Error(
//                 `Invalid file extension for ${fieldName}. Allowed extensions: ${allowedExtensions.join(', ')}`
//             ), false);
//         }

//         console.log(`✅ [ACCEPTED] File passed validation`);
//         cb(null, true);
//     };
// };

// // File type configurations
// const FILE_CONFIGS = {
//     RECORDING: {
//         allowedMimes: [
//             'video/mp4',
//             'video/x-matroska', // .mkv
//             'video/quicktime',  // .mov
//             'video/x-msvideo',  // .avi
//             'video/webm',
//             'video/x-flv',
//             'video/3gpp',
//             'video/mpeg'
//         ],
//         allowedExtensions: ['mp4', 'mkv', 'mov', 'avi', 'webm', 'flv', '3gp', 'mpeg', 'mpg'],
//         maxFileSize: 2 * 1024 * 1024 * 1024, // 2GB
//         description: 'Video recording files'
//     },
//     THUMBNAIL: {
//         allowedMimes: ['image/jpeg', 'image/png', 'image/gif', 'image/webp'],
//         allowedExtensions: ['jpg', 'jpeg', 'png', 'gif', 'webp'],
//         maxFileSize: 5 * 1024 * 1024, // 5MB
//         description: 'Thumbnail images'
//     },
//     DOCUMENT: {
//         allowedMimes: [
//             'application/pdf',
//             'application/msword',
//             'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
//             'application/vnd.ms-powerpoint',
//             'application/vnd.openxmlformats-officedocument.presentationml.presentation',
//             'text/plain'
//         ],
//         allowedExtensions: ['pdf', 'doc', 'docx', 'ppt', 'pptx', 'txt'],
//         maxFileSize: 50 * 1024 * 1024, // 50MB
//         description: 'Document files'
//     },
//     AUDIO: {
//         allowedMimes: [
//             'audio/mpeg',
//             'audio/mp3',
//             'audio/wav',
//             'audio/ogg',
//             'audio/webm'
//         ],
//         allowedExtensions: ['mp3', 'wav', 'ogg', 'webm'],
//         maxFileSize: 100 * 1024 * 1024, // 100MB
//         description: 'Audio files'
//     }
// };

// // Create multer instance with specific configuration
// const createUploader = (config = FILE_CONFIGS.RECORDING, options = {}) => {
//     const fileFilter = createFileFilter(
//         config.allowedMimes,
//         config.allowedExtensions,
//         options.fieldName || 'file'
//     );

//     return multer({
//         storage: storage,
//         limits: {
//             fileSize: options.maxFileSize || config.maxFileSize,
//             files: options.maxFiles || 1
//         },
//         fileFilter: fileFilter
//     });
// };

// // Enhanced sanitize file name function
// export const sanitizeFileName = (fileName, keepOriginal = false) => {
//     if (keepOriginal) {
//         // Only replace spaces with underscores
//         return fileName.replace(/\s+/g, '_');
//     }
    
//     // Generate a clean, URL-safe filename
//     const extension = path.extname(fileName);
//     const baseName = path.basename(fileName, extension);
    
//     const sanitizedBaseName = baseName
//         .replace(/\s+/g, '_')
//         .replace(/[^a-zA-Z0-9_-]/g, '')
//         .toLowerCase()
//         .substring(0, 100); // Limit length
    
//     const timestamp = Date.now();
//     const randomString = uuidv4().substring(0, 8);
    
//     return `${sanitizedBaseName}_${timestamp}_${randomString}${extension}`;
// };

// // Upload File to S3 with enhanced options
// export const uploadToS3 = async (file, folderPath = '', options = {}) => { 
//     const bucketName = process.env.AWS_S3_BUCKET_NAME;
//     const region = process.env.AWS_REGION;
    
//     // Sanitize filename based on options
//     const sanitizedFileName = sanitizeFileName(
//         file.originalname, 
//         options.keepOriginalName || false
//     );
    
//     const timestamp = Date.now();
//     const uniqueId = uuidv4().substring(0, 8);
    
//     // Create file key with folder structure
//     let fileKey;
//     if (folderPath) {
//         fileKey = `${folderPath}/${timestamp}_${uniqueId}_${sanitizedFileName}`;
//     } else {
//         // Default folder structure
//         const date = new Date().toISOString().split('T')[0].replace(/-/g, '/');
//         fileKey = `uploads/${date}/${timestamp}_${uniqueId}_${sanitizedFileName}`;
//     }

//     try {
//         console.log(`📤 [UPLOAD START] Uploading to S3: ${sanitizedFileName}`);
//         console.log(`   - Destination: ${bucketName}/${fileKey}`);
//         console.log(`   - Size: ${(file.size / (1024 * 1024)).toFixed(2)} MB`);
//         console.log(`   - MIME Type: ${file.mimetype}`);

//         const params = {
//             Bucket: bucketName,
//             Key: fileKey,
//             Body: file.buffer,
//             ContentType: file.mimetype,
//             Metadata: {
//                 originalName: file.originalname,
//                 uploadedAt: new Date().toISOString(),
//                 size: file.size.toString(),
//                 uploadId: uniqueId,
//                 ...options.metadata
//             },
//             // Enable server-side encryption if required
//             // ServerSideEncryption: 'AES256',
//             // Add content disposition for download
//             ContentDisposition: options.contentDisposition || 'inline',
//             // Cache control for CDN
//             CacheControl: options.cacheControl || 'public, max-age=31536000'
//         };

//         // Add ACL if specified
//         if (options.acl) {
//             params.ACL = options.acl;
//         }

//         const startTime = Date.now();
//         const result = await s3.upload(params).promise();
//         const endTime = Date.now();
//         const duration = (endTime - startTime) / 1000;

//         const fileUrl = `https://${bucketName}.s3.${region}.amazonaws.com/${fileKey}`;

//         console.log(`✅ [UPLOAD SUCCESS] File Uploaded: ${fileUrl}`);
//         console.log(`   - Duration: ${duration.toFixed(2)} seconds`);
//         console.log(`   - Speed: ${(file.size / (1024 * 1024 * duration)).toFixed(2)} MB/s`);

//         return {
//             url: fileUrl,
//             key: fileKey,
//             bucket: bucketName,
//             region: region,
//             size: file.size,
//             mimeType: file.mimetype,
//             originalName: file.originalname,
//             uploadedAt: new Date(),
//             uploadDuration: duration,
//             metadata: params.Metadata
//         };

//     } catch (error) {
//         console.error(`❌ [UPLOAD FAILED] Error uploading ${file.originalname}:`, error.message);
//         console.error(`   - Error Code: ${error.code}`);
//         console.error(`   - Request ID: ${error.requestId}`);
        
//         // Enhanced error messages
//         let errorMessage = 'File upload failed';
        
//         if (error.code === 'AccessDenied') {
//             errorMessage = 'Access denied to S3 bucket. Check AWS credentials and permissions.';
//         } else if (error.code === 'NoSuchBucket') {
//             errorMessage = `S3 bucket "${bucketName}" does not exist.`;
//         } else if (error.code === 'NetworkError') {
//             errorMessage = 'Network error occurred during upload. Please check your connection.';
//         } else if (error.code === 'RequestTimeout') {
//             errorMessage = 'Upload request timed out. The file might be too large or network is slow.';
//         }
        
//         throw new Error(`${errorMessage} (${error.code || 'Unknown'})`);
//     }
// };

// // Upload multiple files in parallel
// export const uploadMultipleToS3 = async (files, folderPath = '', options = {}) => {
//     const uploadPromises = files.map(file => 
//         uploadToS3(file, folderPath, options)
//     );
    
//     try {
//         console.log(`📤 [BATCH UPLOAD] Starting upload of ${files.length} files`);
//         const results = await Promise.all(uploadPromises);
//         console.log(`✅ [BATCH UPLOAD COMPLETE] All ${files.length} files uploaded successfully`);
        
//         return results;
//     } catch (error) {
//         console.error(`❌ [BATCH UPLOAD FAILED]`, error.message);
//         throw error;
//     }
// };

// // Delete File from S3 with enhanced logging
// export const deleteFileFromS3 = async (fileUrl, options = {}) => {
//     const bucketName = process.env.AWS_S3_BUCKET_NAME;

//     try {
//         if (!fileUrl || typeof fileUrl !== 'string') {
//             throw new Error('Invalid file URL provided');
//         }

//         // Check if it's a full URL or just a key
//         let fileKey;
//         if (fileUrl.startsWith('http')) {
//             try {
//                 const url = new URL(fileUrl);
//                 fileKey = decodeURIComponent(url.pathname.slice(1));
//             } catch (urlError) {
//                 throw new Error(`Invalid URL format: ${fileUrl}`);
//             }
//         } else {
//             // Assume it's already a key
//             fileKey = fileUrl;
//         }

//         if (!fileKey || fileKey.trim() === '') {
//             throw new Error('File key extraction failed');
//         }

//         console.log(`🗑️ [DELETE START] Deleting from S3: ${fileKey}`);

//         const deleteParams = { 
//             Bucket: bucketName, 
//             Key: fileKey 
//         };

//         const result = await s3.deleteObject(deleteParams).promise();
        
//         console.log(`✅ [DELETE SUCCESS] File deleted from S3: ${fileKey}`);
        
//         if (options.deleteThumbnails) {
//             // Try to delete associated thumbnails
//             await deleteThumbnails(fileKey);
//         }
        
//         return {
//             success: true,
//             key: fileKey,
//             deletedAt: new Date(),
//             requestId: result.$response.requestId
//         };

//     } catch (error) {
//         console.error(`❌ [DELETE FAILED] Error deleting file:`, error.message);
//         console.error(`   - File URL: ${fileUrl}`);
//         console.error(`   - Error Code: ${error.code}`);
        
//         // Don't throw for non-critical errors if softDelete is enabled
//         if (options.softDelete) {
//             console.warn(`⚠️ [SOFT DELETE] File marked for deletion but not removed from S3: ${fileUrl}`);
//             return {
//                 success: false,
//                 error: error.message,
//                 key: fileUrl,
//                 softDeleted: true
//             };
//         }
        
//         throw new Error(`Failed to delete file from S3: ${error.message}`);
//     }
// };

// // Helper function to delete thumbnails
// const deleteThumbnails = async (fileKey) => {
//     try {
//         const thumbnailKey = fileKey.replace(/\.(mp4|mkv|mov|avi)$/, '.jpg');
//         if (thumbnailKey !== fileKey) {
//             await s3.deleteObject({
//                 Bucket: process.env.AWS_S3_BUCKET_NAME,
//                 Key: thumbnailKey
//             }).promise();
//             console.log(`✅ [THUMBNAIL DELETED] ${thumbnailKey}`);
//         }
//     } catch (thumbError) {
//         // Non-critical error
//         console.warn(`⚠️ Could not delete thumbnail: ${thumbError.message}`);
//     }
// };

// // Generate signed URL for download with enhanced options
// export const generateSignedUrl = async (fileUrl, options = {}) => {
//     const bucketName = process.env.AWS_S3_BUCKET_NAME;
//     const defaultExpires = options.expiresIn || 3600; // 1 hour default

//     try {
//         let fileKey;
        
//         if (fileUrl.startsWith('http')) {
//             const url = new URL(fileUrl);
//             fileKey = decodeURIComponent(url.pathname.slice(1));
//         } else {
//             fileKey = fileUrl;
//         }

//         if (!fileKey) {
//             throw new Error('Invalid file URL or key');
//         }

//         const params = {
//             Bucket: bucketName,
//             Key: fileKey,
//             Expires: defaultExpires
//         };

//         // Add response headers for download
//         if (options.responseHeaders) {
//             if (options.responseHeaders['Content-Disposition']) {
//                 params.ResponseContentDisposition = options.responseHeaders['Content-Disposition'];
//             }
//             if (options.responseHeaders['Content-Type']) {
//                 params.ResponseContentType = options.responseHeaders['Content-Type'];
//             }
//         }

//         console.log(`🔗 [SIGNED URL] Generating signed URL for: ${fileKey}`);
//         console.log(`   - Expires in: ${defaultExpires} seconds`);
//         console.log(`   - Options:`, options);

//         const signedUrl = await s3.getSignedUrlPromise('getObject', params);
        
//         console.log(`✅ [SIGNED URL GENERATED] URL valid for ${defaultExpires} seconds`);
        
//         return {
//             url: signedUrl,
//             expiresAt: new Date(Date.now() + (defaultExpires * 1000)),
//             key: fileKey,
//             expiresIn: defaultExpires
//         };

//     } catch (error) {
//         console.error('❌ [SIGNED URL ERROR] Failed to generate signed URL:', error.message);
//         console.error(`   - File URL: ${fileUrl}`);
//         console.error(`   - Error Code: ${error.code}`);
        
//         throw new Error(`Failed to generate download URL: ${error.message}`);
//     }
// };

// // Check if file exists in S3
// export const checkFileExists = async (fileUrl) => {
//     try {
//         const url = new URL(fileUrl);
//         const fileKey = decodeURIComponent(url.pathname.slice(1));
        
//         await s3.headObject({
//             Bucket: process.env.AWS_S3_BUCKET_NAME,
//             Key: fileKey
//         }).promise();
        
//         return true;
//     } catch (error) {
//         if (error.code === 'NotFound') {
//             return false;
//         }
//         throw error;
//     }
// };

// // Get file metadata from S3
// export const getFileMetadata = async (fileUrl) => {
//     try {
//         const url = new URL(fileUrl);
//         const fileKey = decodeURIComponent(url.pathname.slice(1));
        
//         const response = await s3.headObject({
//             Bucket: process.env.AWS_S3_BUCKET_NAME,
//             Key: fileKey
//         }).promise();
        
//         return {
//             exists: true,
//             key: fileKey,
//             size: response.ContentLength,
//             lastModified: response.LastModified,
//             contentType: response.ContentType,
//             metadata: response.Metadata,
//             eTag: response.ETag
//         };
//     } catch (error) {
//         if (error.code === 'NotFound') {
//             return { exists: false };
//         }
//         throw error;
//     }
// };

// // Generate upload progress middleware
// export const createProgressMiddleware = (fieldName, options = {}) => {
//     return (req, res, next) => {
//         const progress = {
//             loaded: 0,
//             total: 0,
//             percentage: 0,
//             speed: 0,
//             startTime: Date.now()
//         };

//         // Attach progress tracker to request
//         req.uploadProgress = progress;

//         // Override req.on to track data events
//         const originalOn = req.on;
//         req.on = function(event, listener) {
//             if (event === 'data') {
//                 return originalOn.call(this, event, (chunk) => {
//                     progress.loaded += chunk.length;
//                     progress.total = parseInt(req.headers['content-length']) || progress.total;
//                     progress.percentage = progress.total > 0 ? 
//                         Math.round((progress.loaded / progress.total) * 100) : 0;
                    
//                     const elapsed = (Date.now() - progress.startTime) / 1000;
//                     progress.speed = elapsed > 0 ? progress.loaded / elapsed : 0;
                    
//                     // Emit progress event if socket is available
//                     if (req.socket && options.emitToSocket) {
//                         req.socket.emit('uploadProgress', {
//                             field: fieldName,
//                             ...progress
//                         });
//                     }
                    
//                     listener(chunk);
//                 });
//             }
//             return originalOn.call(this, event, listener);
//         };

//         next();
//     };
// };

// // File Upload Middleware with enhanced configuration
// export const uploadFile = (fields, options = {}) => {
//     return (req, res, next) => {
//         // Create specific configuration for each field
//         const fieldConfigs = fields.map(field => {
//             const config = FILE_CONFIGS[field.type?.toUpperCase()] || FILE_CONFIGS.RECORDING;
//             return {
//                 ...field,
//                 config: config,
//                 maxCount: field.maxCount || 1,
//                 maxFileSize: field.maxFileSize || config.maxFileSize
//             };
//         });

//         // Create multer instance for each field
//         const uploadMiddlewares = fieldConfigs.map(fieldConfig => {
//             const uploader = createUploader(fieldConfig.config, {
//                 fieldName: fieldConfig.name,
//                 maxFileSize: fieldConfig.maxFileSize,
//                 maxFiles: fieldConfig.maxCount
//             });
            
//             return uploader.array(fieldConfig.name, fieldConfig.maxCount);
//         });

//         // Chain all upload middlewares
//         const chainMiddlewares = (middlewares, index = 0) => {
//             if (index === middlewares.length) return next;
            
//             return (err) => {
//                 if (err) return handleUploadError(err, res);
//                 middlewares[index](req, res, chainMiddlewares(middlewares, index + 1));
//             };
//         };

//         // Start the chain
//         chainMiddlewares(uploadMiddlewares)();
//     };
// };

// // Error handler for upload middleware
// const handleUploadError = (err, res) => {
//     console.error('❌ [UPLOAD MIDDLEWARE ERROR]:', err.message);
    
//     let statusCode = 400;
//     let errorMessage = err.message;
    
//     if (err.code === 'LIMIT_FILE_SIZE') {
//         errorMessage = 'File size exceeds the maximum allowed limit.';
//     } else if (err.code === 'LIMIT_FILE_COUNT') {
//         errorMessage = 'Too many files uploaded.';
//     } else if (err.code === 'LIMIT_UNEXPECTED_FILE') {
//         errorMessage = 'Unexpected file field.';
//     } else if (err.message.includes('Invalid file type')) {
//         errorMessage = err.message;
//     } else {
//         statusCode = 500;
//         errorMessage = 'An error occurred during file upload.';
//     }
    
//     return res.status(statusCode).json({
//         success: false,
//         message: errorMessage,
//         error: process.env.NODE_ENV === 'development' ? err.message : undefined,
//         code: err.code
//     });
// };

// // Upload single file with specific type
// export const uploadSingleFile = (fieldName, fileType = 'RECORDING', options = {}) => {
//     const config = FILE_CONFIGS[fileType.toUpperCase()] || FILE_CONFIGS.RECORDING;
    
//     return uploadFile([{
//         name: fieldName,
//         type: fileType,
//         maxCount: 1,
//         maxFileSize: options.maxFileSize || config.maxFileSize
//     }], options);
// };

// // Upload multiple files
// export const uploadMultipleFiles = (fieldName, fileType = 'RECORDING', maxCount = 10, options = {}) => {
//     const config = FILE_CONFIGS[fileType.toUpperCase()] || FILE_CONFIGS.RECORDING;
    
//     return uploadFile([{
//         name: fieldName,
//         type: fileType,
//         maxCount: maxCount,
//         maxFileSize: options.maxFileSize || config.maxFileSize
//     }], options);
// };

// // Video-specific upload middleware with progress tracking
// export const uploadVideo = (fieldName = 'recording', options = {}) => {
//     const videoOptions = {
//         ...options,
//         maxFileSize: options.maxFileSize || FILE_CONFIGS.RECORDING.maxFileSize,
//         maxFiles: 1
//     };
    
//     return [
//         createProgressMiddleware(fieldName, options),
//         uploadSingleFile(fieldName, 'RECORDING', videoOptions)
//     ];
// };

// // Batch upload for multiple video files
// export const uploadVideos = (fieldName = 'recordings', maxCount = 5, options = {}) => {
//     const videoOptions = {
//         ...options,
//         maxFileSize: options.maxFileSize || FILE_CONFIGS.RECORDING.maxFileSize,
//         maxFiles: maxCount
//     };
    
//     return uploadMultipleFiles(fieldName, 'RECORDING', maxCount, videoOptions);
// };

// // Generate folder structure based on date and session
// export const generateFolderPath = (sessionId = '', type = 'recordings') => {
//     const date = new Date();
//     const year = date.getFullYear();
//     const month = String(date.getMonth() + 1).padStart(2, '0');
//     const day = String(date.getDate()).padStart(2, '0');
    
//     let folderPath = `${type}/${year}/${month}/${day}`;
    
//     if (sessionId) {
//         folderPath += `/${sessionId}`;
//     }
    
//     return folderPath;
// };

// // Utility to extract file info from uploaded files
// export const extractFileInfo = (req) => {
//     if (!req.files || Object.keys(req.files).length === 0) {
//         return null;
//     }
    
//     const fileInfo = {};
    
//     Object.keys(req.files).forEach(fieldName => {
//         fileInfo[fieldName] = req.files[fieldName].map(file => ({
//             originalName: file.originalname,
//             size: file.size,
//             mimeType: file.mimetype,
//             buffer: file.buffer,
//             fieldName: fieldName,
//             encoding: file.encoding
//         }));
//     });
    
//     return fileInfo;
// };

// // Log uploaded files for debugging
// export const logUploadedFiles = (req) => {
//     if (!req.files) {
//         console.log('📭 [NO FILES] No files were uploaded');
//         return;
//     }
    
//     console.log('📂 [UPLOADED FILES SUMMARY]');
//     Object.keys(req.files).forEach(fieldName => {
//         const files = req.files[fieldName];
//         console.log(`   Field: ${fieldName}`);
//         console.log(`   Count: ${files.length}`);
        
//         files.forEach((file, index) => {
//             console.log(`     ${index + 1}. ${file.originalname}`);
//             console.log(`        Size: ${(file.size / (1024 * 1024)).toFixed(2)} MB`);
//             console.log(`        Type: ${file.mimetype}`);
//         });
//     });
    
//     console.log(`📊 [TOTAL] ${Object.values(req.files).flat().length} files uploaded`);
// };

// // Default export
// export default {
//     // Core functions
//     uploadToS3,
//     uploadMultipleToS3,
//     deleteFileFromS3,
//     generateSignedUrl,
    
//     // Upload middleware
//     uploadFile,
//     uploadSingleFile,
//     uploadMultipleFiles,
//     uploadVideo,
//     uploadVideos,
    
//     // Utilities
//     sanitizeFileName,
//     checkFileExists,
//     getFileMetadata,
//     generateFolderPath,
//     extractFileInfo,
//     logUploadedFiles,
//     createProgressMiddleware,
    
//     // Constants
//     FILE_CONFIGS,
    
//     // AWS S3 instance (for advanced usage)
//     s3
// };












import AWS from 'aws-sdk';
import multer from 'multer';
import dotenv from 'dotenv';

dotenv.config();

// Environment Variables Check
const requiredEnvVars = [
    "AWS_ACCESS_KEY_ID",
    "AWS_SECRET_ACCESS_KEY",
    "AWS_REGION",
    "AWS_S3_BUCKET_NAME"
];

requiredEnvVars.forEach((key) => {
    if (!process.env[key]) {
        throw new Error(`❌ Missing environment variable: ${key}`);
    }
});

// AWS S3 Configuration
const s3 = new AWS.S3({
    accessKeyId: process.env.AWS_ACCESS_KEY_ID,
    secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY,
    region: process.env.AWS_REGION,
    signatureVersion: 'v4'
});

// Multer Storage
const storage = multer.memoryStorage();
const upload = multer({ storage });

// Function to sanitize file name
const sanitizeFileName = (fileName) => {
    return fileName.replace(/\s+/g, '_').replace(/[^\w.-]/g, '');
};

// Upload File to S3
export const uploadToS3 = async (file, apiFolder = '') => { 
    const bucketName = process.env.AWS_S3_BUCKET_NAME;
    const sanitizedFileName = sanitizeFileName(file.originalname);
    const fileKey = apiFolder ? `${apiFolder}/${Date.now()}_${sanitizedFileName}` : `${Date.now()}_${sanitizedFileName}`;

    try {
        const params = {
            Bucket: bucketName,
            Key: fileKey,
            Body: file.buffer,
            ContentType: file.mimetype
        };

        await s3.upload(params).promise();
        const fileUrl = `https://${bucketName}.s3.${process.env.AWS_REGION}.amazonaws.com/${fileKey}`;

        console.log(`✅ [UPLOAD SUCCESS] File Uploaded: ${fileUrl}`);
        return fileUrl;
    } catch (error) {
        console.error(`❌ [ERROR] Upload Failed: ${error.message}`);
        throw new Error('File upload failed');
    }
};

// Delete File from S3
export const deleteFileFromS3 = async (fileUrl) => {
    const bucketName = process.env.AWS_S3_BUCKET_NAME;

    try {
        if (!fileUrl || typeof fileUrl !== 'string' || !fileUrl.startsWith('http')) {
            console.error('❌ [ERROR] Invalid or missing fileUrl:', fileUrl);
            return;
        }

        const url = new URL(fileUrl);
        const fileKey = decodeURIComponent(url.pathname.slice(1)); // Removes leading "/"

        if (!fileKey) {
            console.error('❌ [ERROR] File key extraction failed.');
            return;
        }

        const deleteParams = { Bucket: bucketName, Key: fileKey };

        await s3.deleteObject(deleteParams).promise();
        console.log(`✅ [DELETE SUCCESS] File deleted from S3: ${fileKey}`);
    } catch (error) {
        console.error(`❌ [ERROR] Failed to delete file from S3: ${error.message}`);
        throw new Error('File delete failed');
    }
};


export const uploadSingleFile = (fieldName) => {
    return async (req, res, next) => {
        const uploadMiddleware = upload.single(fieldName);
        
        uploadMiddleware(req, res, async (err) => {
            if (err) {
                console.error('❌ [ERROR] Single file upload failed:', err.message);
                return res.status(400).json({ message: '❌ File upload failed', error: err.message });
            }

            console.log("📂 [DEBUG SINGLE] req.file:", req.file);
            console.log("📋 [DEBUG SINGLE] req.body:", req.body);

            if (!req.file) {
                console.log("⚠️ [INFO] No file uploaded for single upload");
                return next();
            }

            try {
                console.log(`📁 [PROCESSING] Uploading single file: ${req.file.originalname}`);
                const folderName = 'lectures'; // या जो भी folder चाहिए
                const uploadedFileUrl = await uploadToS3(req.file, folderName);
                
                console.log(`✅ [UPLOADED SINGLE] File URL: ${uploadedFileUrl}`);

                // Create fileUrls object similar to multiple upload
                req.fileUrls = {
                    [fieldName]: {
                        fileName: req.file.originalname,
                        fileUrl: uploadedFileUrl,
                        fileType: req.file.mimetype,
                        uploadedBy: req.user?._id || req.tokenData?.userId || null,
                        uploadedAt: new Date()
                    }
                };
                
                // Also add to req.body for backward compatibility
                if (!req.body.fileUrls) {
                    req.body.fileUrls = {};
                }
                req.body.fileUrls[fieldName] = req.fileUrls[fieldName];
                
                console.log("✅ [MIDDLEWARE SINGLE] Upload completed successfully");
                console.log("📦 [req.fileUrls single]:", req.fileUrls);
                
                next();

            } catch (error) {
                console.error('❌ [ERROR] Single file handling failed:', error.message);
                return res.status(500).json({ message: '❌ Single file upload error', error: error.message });
            }
        });
    };
};


// middleware में console.log जोड़ें:
export const uploadFile = (fields) => {
    return (req, res, next) => {
        const uploadMiddleware = upload.fields(fields);

        uploadMiddleware(req, res, async (err) => {
            if (err) {
                console.error('❌ [ERROR] File upload failed:', err.message);
                return res.status(400).json({ message: '❌ File upload failed', error: err.message });
            }

            console.log("📂 [DEBUG] req.files (multer के बाद):", req.files);
            console.log("📋 [DEBUG] req.body (multer के बाद):", req.body);

            if (!req.files) {
                return res.status(400).json({ message: '❌ No files uploaded' });
            }

            const fileUrls = {};
            const uploadedFiles = [];
            const folderName = 'lectures'; // अलग folder बना दें lectures के लिए

            try {
                for (const field of fields) {
                    if (req.files[field.name]?.length > 0) {
                        const uploadedFileObjs = [];

                        for (const file of req.files[field.name]) {
                            console.log(`📁 [PROCESSING] Uploading file: ${file.originalname}`);
                            const uploadedFileUrl = await uploadToS3(file, folderName);
                            
                            console.log(`✅ [UPLOADED] File URL: ${uploadedFileUrl}`);

                            uploadedFileObjs.push({
                                fileName: file.originalname,
                                fileUrl: uploadedFileUrl,
                                fileType: file.mimetype,
                                uploadedBy: req.user?._id || req.tokenData?.userId || null,
                                uploadedAt: new Date()
                            });

                            uploadedFiles.push(uploadedFileUrl);
                        }

                        // यहाँ महत्वपूर्ण है - सीधे object assign करें
                        fileUrls[field.name] = uploadedFileObjs;
                    } else {
                        console.log(`⚠️ [INFO] No new files for field: ${field.name}`);
                    }
                }

                console.log("📦 [FINAL] fileUrls object:", JSON.stringify(fileUrls, null, 2));
                
                // req.body में merge करने के बजाय, सीधे req.fileUrls में assign करें
                req.fileUrls = fileUrls;
                
                // req.body में भी assign करें बैकअप के लिए
                Object.assign(req.body, fileUrls);
                
                console.log("✅ [MIDDLEWARE] Upload completed successfully");
                console.log("📦 [req.fileUrls]:", req.fileUrls);
                console.log("📋 [req.body after merge]:", req.body);
                
                next();

            } catch (error) {
                console.error('❌ [ERROR] Middleware file handling failed:', error.message);

                // Rollback uploaded files
                for (const fileUrl of uploadedFiles) {
                    await deleteFileFromS3(fileUrl);
                }

                return res.status(500).json({ message: '❌ File upload error', error: error.message });
            }
        });
    };
};



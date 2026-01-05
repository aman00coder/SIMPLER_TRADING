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

// File Upload Middleware with detailed file info
// export const uploadFile = (fields) => {
//     return (req, res, next) => {
//         const uploadMiddleware = upload.fields(fields);

//         uploadMiddleware(req, res, async (err) => {
//             if (err) {
//                 console.error('❌ [ERROR] File upload failed:', err.message);
//                 return res.status(400).json({ message: '❌ File upload failed', error: err.message });
//             }

//             console.log("📂 [DEBUG] req.files:", req.files);
//             console.log("📋 [DEBUG] req.body:", req.body);

//             if (!req.files) {
//                 return res.status(400).json({ message: '❌ No files uploaded' });
//             }

//             const fileUrls = {};
//             const uploadedFiles = [];
//             const folderName = ''; // agar chahiye to yahan folder name daal sakte ho

//             try {
//                 for (const field of fields) {
//                     if (req.files[field.name]?.length > 0) {
//                         const uploadedFileObjs = [];

//                         for (const file of req.files[field.name]) {
//                             const uploadedFileUrl = await uploadToS3(file, folderName);

//                             uploadedFileObjs.push({
//                                 fileName: file.originalname,
//                                 fileUrl: uploadedFileUrl,
//                                 fileType: file.mimetype,
//                                 uploadedBy: req.user?._id || null, // Agar authentication middleware hai to id milegi
//                                 uploadedAt: new Date()
//                             });

//                             uploadedFiles.push(uploadedFileUrl);
//                         }

//                         fileUrls[field.name] = uploadedFileObjs;
//                     } else {
//                         // Agar koi existing files update karna ho to wo body me bheja gaya hoga
//                         fileUrls[field.name] = req.body[`existing_${field.name}`] || [];
//                     }
//                 }

//                 // req.body me file info merge kar do
//                 req.body = { ...req.body, ...fileUrls };
//                 next();

//             } catch (error) {
//                 console.error('❌ [ERROR] Middleware file handling failed:', error.message);

//                 // Agar upload ke beech error aaya, to uploaded files delete kar do
//                 for (const fileUrl of uploadedFiles) {
//                     await deleteFileFromS3(fileUrl);
//                 }

//                 return res.status(500).json({ message: '❌ File upload error', error: error.message });
//             }
//         });
//     };
// };


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

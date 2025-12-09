import { v4 as uuidv4 } from "uuid";
import courseModel from "../../model/course/course.model.js";
import authenticationModel from "../../model/Authentication/authentication.model.js";
import * as commonServices from "../../services/common.js";
import { sendSuccessResponse, sendErrorResponse } from "../../responses/responses.js";
import { errorEn, successEn } from "../../responses/message.js";
import { getIO } from "../../services/socket.integrated.js";
import { ROLE_MAP, ROLE_REVERSE_MAP } from "../../constant/role.js";
import HttpStatus from "http-status-codes";
import mongoose from "mongoose";
import { deleteFileFromS3 } from '../../middleware/aws.s3.js';

export const createCourse = async (req, res) => {
    try {
        const { 
            title, 
            description, 
            category, 
            level, 
            price, 
            language, 
            duration,
            isActive,
            tags,
            liveClasses,
            quizzes,
            assignments
        } = req.body;

        console.log("📋 [CREATE COURSE] Raw req.body:", req.body);
        console.log("📁 [CREATE COURSE] req.fileUrls:", req.fileUrls);

        // Check required fields
        if (!title || !description || !category || !level || !price) {
            return res.status(400).json({
                message: "❌ Please provide title, description, category, level, and price"
            });
        }

        // Parse JSON strings
        const parsedTags = tags ? JSON.parse(tags) : [];
        const parsedLiveClasses = liveClasses ? JSON.parse(liveClasses) : [];
        const parsedQuizzes = quizzes ? JSON.parse(quizzes) : [];
        const parsedAssignments = assignments ? JSON.parse(assignments) : [];

        // Get uploaded files
        const uploadedThumbnail = req.fileUrls?.thumbnail || [];
        const uploadedLectures = req.fileUrls?.lectures || [];
        const uploadedAssignments = req.fileUrls?.assignments || [];

        // Use ONLY uploaded files
        const finalLectures = [...uploadedLectures];
        const finalAssignments = [...uploadedAssignments, ...parsedAssignments];

        // Get thumbnail (should be single file)
        const thumbnailFile = uploadedThumbnail.length > 0 ? uploadedThumbnail[0] : null;

        if (!thumbnailFile) {
            return res.status(400).json({
                message: "❌ Course thumbnail is required"
            });
        }

        // ✅ FIXED: thumbnail को सिर्फ string (URL) format में भेजें
        const courseData = {
            title,
            description,
            category,
            level,
            price: Number(price),
            language,
            duration: Number(duration),
            isActive: isActive === 'true',
            tags: parsedTags,
            thumbnail: thumbnailFile.fileUrl, // ✅ सिर्फ URL string
            liveClasses: parsedLiveClasses,
            quizzes: parsedQuizzes,
            lectures: uploadedLectures.map(lecture => ({
                title: lecture.fileName.replace(/\.[^/.]+$/, ""), // Remove file extension
                type: this.getFileType(lecture.fileType), // Helper function
                url: lecture.fileUrl,
                duration: 0, // Default duration
                isPreviewFree: false
            })),
            assignments: finalAssignments.map(assignment => ({
                title: assignment.fileName ? assignment.fileName.replace(/\.[^/.]+$/, "") : "Assignment",
                description: assignment.description || "Assignment file",
                dueDate: assignment.dueDate || new Date(Date.now() + 7 * 24 * 60 * 60 * 1000), // 7 days from now
                resources: assignment.fileUrl ? [assignment.fileUrl] : []
            })),
            createdBy: req.user?._id || req.tokenData?.userId,
            createdAt: new Date()
        };

        console.log("📝 [CREATE COURSE] Final course data:", courseData);

        // Create course in database
        const newCourse = await courseModel.create(courseData);

        return res.status(201).json({
            success: true,
            message: "✅ Course created successfully",
            data: newCourse
        });

    } catch (error) {
        console.error('❌ createCourse error:', error);
        
        // Delete uploaded files if course creation fails
        if (req.fileUrls) {
            try {
                const filesToDelete = [
                    ...(req.fileUrls.thumbnail || []),
                    ...(req.fileUrls.lectures || []),
                    ...(req.fileUrls.assignments || [])
                ];
                
                for (const file of filesToDelete) {
                    if (file.fileUrl) {
                        await deleteFileFromS3(file.fileUrl);
                    }
                }
                console.log("🔄 [ROLLBACK] Uploaded files deleted due to error");
            } catch (deleteError) {
                console.error("❌ [ROLLBACK ERROR] Failed to delete files:", deleteError);
            }
        }

        return res.status(500).json({
            message: "❌ Internal server error",
            error: error.message
        });
    }
};

// Helper function to determine file type
function getFileType(mimeType) {
    if (mimeType.startsWith('video/')) return 'video';
    if (mimeType === 'application/pdf') return 'pdf';
    if (mimeType.includes('presentation') || mimeType.includes('powerpoint')) return 'ppt';
    return 'note';
}


// Check if user is enrolled in a course
// export const checkEnrollment = async (req, res) => {
//   try {
//     const { courseId } = req.params;
//     const userId = req.tokenData?.userId;

//     // Find course
//     const course = await courseModel.findById(courseId).select('title description thumbnail category level price enrolledUsers');
    
//     if (!course) {
//       return res.status(404).json({
//         success: false,
//         message: 'Course not found'
//       });
//     }

//     // Check if user is enrolled
//     const isEnrolled = course.enrolledUsers.some(
//       enrollment => enrollment.user.toString() === userId
//     );

//     res.status(200).json({
//       success: true,
//       isEnrolled,
//       course: {
//         _id: course._id,
//         title: course.title,
//         description: course.description,
//         thumbnail: course.thumbnail,
//         category: course.category,
//         level: course.level,
//         price: course.price,
//         enrolledCount: course.enrolledUsers.length
//       }
//     });

//   } catch (error) {
//     console.error('Error checking enrollment:', error);
//     res.status(500).json({
//       success: false,
//       message: 'Server error while checking enrollment'
//     });
//   }
// };



export const getSingleCourseForEnrolledUsers = async (req, res) => {
  try {
    const { id } = req.params;
    const userId = req.tokenData?.userId;
    const userRole = req.tokenData?.role;

    if (!id) {
      return sendErrorResponse(res, errorEn.MISSING_FIELDS, HttpStatus.BAD_REQUEST);
    }

    const course = await courseModel.findById(id)
      .populate("createdBy", "name email profilePic")
      .lean();

    if (!course) {
      return sendErrorResponse(res, errorEn.NO_DATA_FOUND, HttpStatus.NOT_FOUND);
    }

    // Check if user is enrolled (only for VIEWER role)
    let isEnrolled = false;
    let enrollmentInfo = null;
    let canAccessCourse = true; // Flag to determine if user can access course content
    let accessMessage = null;

    if (userRole === ROLE_MAP.VIEWER && userId) {
      // Find the course document to check enrollment
      const courseDoc = await courseModel.findById(id);
      
      if (!courseDoc) {
        return sendErrorResponse(res, errorEn.NO_DATA_FOUND, HttpStatus.NOT_FOUND);
      }

      // Find user's enrollment
      const enrollment = courseDoc.enrolledUsers.find(
        e => e.user && e.user.toString() === userId
      );
      
      if (enrollment) {
        isEnrolled = true;
        enrollmentInfo = {
          enrolledAt: enrollment.enrolledAt,
          progress: enrollment.progress,
          completedLectures: enrollment.completedLectures,
          lastAccessed: enrollment.lastAccessed
        };
        
        // Update last accessed time
        courseDoc.enrolledUsers = courseDoc.enrolledUsers.map(e => {
          if (e.user.toString() === userId) {
            return {
              ...e,
              lastAccessed: new Date()
            };
          }
          return e;
        });
        
        await courseDoc.save();
      } else {
        // User is not enrolled
        canAccessCourse = false;
        accessMessage = "You are not enrolled in this course. Please enroll first to access course content.";
        
        // Hide sensitive course content for non-enrolled users
        course.lectures = course.lectures.map(lecture => ({
          ...lecture,
          // Hide actual URL for non-preview lectures
          url: lecture.isPreviewFree ? lecture.url : null,
          // Add message for locked content
          isLocked: !lecture.isPreviewFree,
          lockMessage: lecture.isPreviewFree ? null : "Enroll to access this lecture"
        }));
        
        // Hide quizzes and assignments for non-enrolled users
        course.quizzes = [];
        course.assignments = [];
        course.liveClasses = course.liveClasses?.filter(liveClass => 
          liveClass.isPrivate === false
        ) || [];
      }
    } else if (userRole === ROLE_MAP.MENTOR || userRole === ROLE_MAP.ADMIN) {
      // Mentors and Admins can access all courses
      isEnrolled = true;
      canAccessCourse = true;
      enrollmentInfo = {
        specialAccess: `${userRole} access`,
        accessedAt: new Date()
      };
    } else {
      // Guest users (no token or other roles)
      canAccessCourse = false;
      accessMessage = "Please login and enroll to access this course.";
      
      // Hide all content for guests
      course.lectures = course.lectures.map(lecture => ({
        title: lecture.title,
        type: lecture.type,
        duration: lecture.duration,
        isPreviewFree: lecture.isPreviewFree,
        url: lecture.isPreviewFree ? lecture.url : null,
        isLocked: !lecture.isPreviewFree,
        lockMessage: lecture.isPreviewFree ? null : "Enroll to access this lecture"
      }));
      
      course.quizzes = [];
      course.assignments = [];
      course.liveClasses = course.liveClasses?.filter(liveClass => 
        liveClass.isPrivate === false
      ) || [];
    }

    // Get enrolled count
    const totalEnrolled = await courseModel.findById(id).select('enrolledUsers');
    const enrolledCount = totalEnrolled?.enrolledUsers?.length || 0;

    const response = {
      ...course,
      isEnrolled,
      enrollmentInfo,
      enrolledCount,
      canAccessCourse,
      accessMessage: canAccessCourse ? null : accessMessage,
      // Add enrollment prompt if not enrolled
      enrollmentPrompt: !isEnrolled ? {
        message: "Enroll now to get full access to this course",
        enrollUrl: `/api/courses/${id}/enroll`,
        isFree: course.price === 0
      } : null
    };

    return sendSuccessResponse(res, response, successEn.COURSE_FETCHED, HttpStatus.OK);
  } catch (error) {
    console.log("Error fetching course:", error.message);
    return sendErrorResponse(res, errorEn.INTERNAL_SERVER_ERROR, HttpStatus.INTERNAL_SERVER_ERROR);
  }
};


export const getAllCoursesForUser = async (req, res) => {
  try {
    const courses = await courseModel
      .find({ isActive: true }) // Only active courses
      .select('title thumbnail category level price rating enrolledUsers duration language tags createdBy isActive') // Only selected fields
      .populate("createdBy", "name") // Only name needed
      .lean();

    if (!courses || courses.length === 0) {
      return sendErrorResponse(res, errorEn.NO_DATA_FOUND, HttpStatus.NOT_FOUND);
    }

    // Transform data to minimal format
    const minimalCourses = courses.map(course => ({
      _id: course._id,
      title: course.title || 'Untitled Course',
      thumbnail: course.thumbnail || null,
      category: course.category || 'General',
      level: course.level || 'Beginner',
      price: course.price || 0,
      rating: course.rating || 0,
      enrolledCount: course.enrolledUsers?.length || 0,
      duration: course.duration || 0,
      language: course.language || 'English',
      tags: course.tags || [],
      isActive: course.isActive !== false,
      instructor: course.createdBy?.name || 'Expert Instructor',
      // Add derived fields if needed
      isFree: course.price === 0,
      hasEnrollments: (course.enrolledUsers?.length || 0) > 0
    }));

    return sendSuccessResponse(
      res,
      minimalCourses,
      successEn.COURSE_FETCHED,
      HttpStatus.OK
    );
  } catch (error) {
    console.log('Error in getAllCoursesMinimal:', error.message);
    return sendErrorResponse(
      res,
      errorEn.INTERNAL_SERVER_ERROR,
      HttpStatus.INTERNAL_SERVER_ERROR
    );
  }
};


export const checkEnrollment = async (req, res) => {
  try {
    const { courseId } = req.params;
    const userId = req.user?.userId || req.tokenData?.userId;

    // Validate courseId
    if (!courseId) {
      return res.status(400).json({
        success: false,
        message: 'Course ID is required'
      });
    }

    // Validate userId
    if (!userId) {
      return res.status(401).json({
        success: false,
        message: 'User authentication required'
      });
    }

    // Validate ObjectId format
    if (!mongoose.Types.ObjectId.isValid(courseId)) {
      return res.status(400).json({
        success: false,
        message: 'Invalid course ID format'
      });
    }

    // Find course with proper error handling
    let course;
    try {
      course = await courseModel.findById(courseId).select(
        'title description thumbnail category level price enrolledUsers isActive'
      );
    } catch (dbError) {
      console.error('Database error finding course:', dbError);
      return res.status(500).json({
        success: false,
        message: 'Database error while fetching course'
      });
    }
    
    if (!course) {
      return res.status(404).json({
        success: false,
        message: 'Course not found',
        courseId: courseId
      });
    }

    // Check if course is active
    if (course.isActive === false) {
      return res.status(403).json({
        success: false,
        message: 'This course is no longer available',
        course: {
          _id: course._id,
          title: course.title,
          isActive: false
        }
      });
    }

    // Check if user is enrolled - safe check
    let isEnrolled = false;
    try {
      isEnrolled = course.enrolledUsers.some(
        enrollment => enrollment.user && enrollment.user.toString() === userId
      );
    } catch (enrollmentError) {
      console.error('Error checking enrollment:', enrollmentError);
      // Continue with isEnrolled = false
    }

    // Prepare course data for response
    const courseData = {
      _id: course._id,
      title: course.title || 'Untitled Course',
      description: course.description || 'No description available',
      thumbnail: course.thumbnail || null,
      category: course.category || 'Uncategorized',
      level: course.level || 'Beginner',
      price: course.price || 0,
      enrolledCount: course.enrolledUsers?.length || 0,
      isActive: course.isActive !== false
    };

    res.status(200).json({
      success: true,
      isEnrolled,
      course: courseData,
      timestamp: new Date().toISOString()
    });

  } catch (error) {
    console.error('Error in checkEnrollment controller:', error);
    
    // Provide more specific error messages
    let errorMessage = 'Server error while checking enrollment';
    let statusCode = 500;
    
    if (error.name === 'CastError') {
      errorMessage = 'Invalid course ID format';
      statusCode = 400;
    } else if (error.name === 'ValidationError') {
      errorMessage = 'Validation error';
      statusCode = 400;
    }
    
    res.status(statusCode).json({
      success: false,
      message: errorMessage,
      error: process.env.NODE_ENV === 'development' ? error.message : undefined,
      courseId: req.params.courseId
    });
  }
};



// ✅ Get All Courses
export const getAllCourse = async (req, res) => {
  try {
    const courses = await courseModel
      .find()
      .populate("createdBy", "name email") 
      .lean();

    if (!courses || courses.length === 0) {
      return sendErrorResponse(res, errorEn.NO_DATA_FOUND, HttpStatus.NOT_FOUND);
    }

    return sendSuccessResponse(
      res,
      courses,
      successEn.COURSE_FETCHED,
      HttpStatus.OK
    );
  } catch (error) {
    console.log(error.message);
    return sendErrorResponse(
      res,
      errorEn.INTERNAL_SERVER_ERROR,
      HttpStatus.INTERNAL_SERVER_ERROR
    );
  }
};

// ✅ Get Single Course
export const getSingleCourse = async (req, res) => {
  try {
    const { id } = req.params;
    const userId = req.tokenData?.userId;
    const userRole = req.tokenData?.role;

    if (!id) {
      return sendErrorResponse(res, errorEn.MISSING_FIELDS, HttpStatus.BAD_REQUEST);
    }

    const course = await courseModel.findById(id)
      .populate("createdBy", "name email profilePic")
      .lean();

    if (!course) {
      return sendErrorResponse(res, errorEn.NO_DATA_FOUND, HttpStatus.NOT_FOUND);
    }

    let isEnrolled = false;
    let enrollmentInfo = null;

    if (userRole === ROLE_MAP.VIEWER && userId) {
      const courseDoc = await courseModel.findById(id);
      const enrollment = courseDoc.enrolledUsers.find(
        e => e.user && e.user.toString() === userId
      );
      
      if (enrollment) {
        isEnrolled = true;
        enrollmentInfo = {
          enrolledAt: enrollment.enrolledAt,
          progress: enrollment.progress,
          completedLectures: enrollment.completedLectures,
          lastAccessed: enrollment.lastAccessed
        };
      }
    }

    const totalEnrolled = await courseModel.findById(id).select('enrolledUsers');
    const enrolledCount = totalEnrolled?.enrolledUsers?.length || 0;

    const response = {
      ...course,
      isEnrolled,
      enrollmentInfo,
      enrolledCount
    };

    return sendSuccessResponse(res, response, successEn.COURSE_FETCHED, HttpStatus.OK);
  } catch (error) {
    console.log(error.message);
    return sendErrorResponse(res, errorEn.INTERNAL_SERVER_ERROR, HttpStatus.INTERNAL_SERVER_ERROR);
  }
};

// ✅ Update Course
export const updateCourse = async (req, res) => {
  try {
    const { id } = req.params;

    if (!id) {
      return sendErrorResponse(res, errorEn.MISSING_FIELDS, HttpStatus.BAD_REQUEST);
    }

    const course = await courseModel.findById(id);
    if (!course) {
      return sendErrorResponse(res, errorEn.NO_DATA_FOUND, HttpStatus.NOT_FOUND);
    }

    const userId = req.tokenData?.userId;
    const userRole = req.tokenData?.role;
    
    // ADMIN aur STREAMER dono ek dusre ke courses update kar sakte hain
    if (![ROLE_MAP.ADMIN, ROLE_MAP.STREAMER].includes(userRole)) {
      return sendErrorResponse(res, "You are not authorized to update courses", HttpStatus.FORBIDDEN);
    }

    const thumbnailFile = req.files?.thumbnail?.[0];
    const lectureFiles = req.files?.lectures || [];
    const assignmentFiles = req.files?.assignments || [];

    if (thumbnailFile && course.thumbnail) {
      await deleteFileFromS3(course.thumbnail);
      course.thumbnail = thumbnailFile.location;
    }

    if (lectureFiles.length > 0) {
      if (course.lectures && course.lectures.length > 0) {
        for (const lec of course.lectures) {
          if (lec.url) await deleteFileFromS3(lec.url);
        }
      }

      course.lectures = lectureFiles.map((file) => ({
        title: req.body.title || "Lecture",
        type: "video",
        url: file.location,
        duration: req.body.duration || 0,
        isPreviewFree: req.body.isPreviewFree === "true"
      }));
    }

    if (assignmentFiles.length > 0) {
      if (course.assignments && course.assignments.length > 0) {
        for (const asg of course.assignments) {
          for (const res of asg.resources) {
            await deleteFileFromS3(res);
          }
        }
      }

      course.assignments = [
        {
          title: req.body.assignmentTitle || "Assignment",
          description: req.body.assignmentDescription || "",
          dueDate: req.body.dueDate || null,
          resources: assignmentFiles.map((x) => x.location)
        }
      ];
    }

    const updatableFields = [
      "title",
      "description",
      "category",
      "tags",
      "level",
      "price",
      "language",
      "duration",
      "rating",
      "isActive"
    ];

    updatableFields.forEach((field) => {
      if (req.body[field] !== undefined) {
        course[field] = req.body[field];
      }
    });

    await course.save();

    return sendSuccessResponse(res, course, successEn.COURSE_UPDATED, HttpStatus.OK);

  } catch (error) {
    console.log(error.message);
    return sendErrorResponse(res, errorEn.INTERNAL_SERVER_ERROR, HttpStatus.INTERNAL_SERVER_ERROR);
  }
};

// ✅ Delete Course
export const deleteCourse = async (req, res) => {
  try {
    const { id } = req.params;

    if (!id) {
      return sendErrorResponse(res, errorEn.MISSING_FIELDS, HttpStatus.BAD_REQUEST);
    }

    const course = await courseModel.findById(id);
    if (!course) {
      return sendErrorResponse(res, errorEn.NO_DATA_FOUND, HttpStatus.NOT_FOUND);
    }

    const userId = req.tokenData?.userId;
    const userRole = req.tokenData?.role;
    
    // ADMIN aur STREAMER dono ek dusre ke courses delete kar sakte hain
    if (![ROLE_MAP.ADMIN, ROLE_MAP.STREAMER].includes(userRole)) {
      return sendErrorResponse(res, "You are not authorized to delete courses", HttpStatus.FORBIDDEN);
    }

    if (course.thumbnail) {
      await deleteFileFromS3(course.thumbnail);
    }

    if (course.lectures && course.lectures.length > 0) {
      for (const lec of course.lectures) {
        if (lec.url) {
          await deleteFileFromS3(lec.url);
        }
      }
    }

    if (course.assignments && course.assignments.length > 0) {
      for (const asg of course.assignments) {
        if (asg.resources && asg.resources.length > 0) {
          for (const fileUrl of asg.resources) {
            await deleteFileFromS3(fileUrl);
          }
        }
      }
    }

    await courseModel.findByIdAndDelete(id);

    return sendSuccessResponse(
      res,
      null,
      successEn.COURSE_DELETED || "Course deleted successfully",
      HttpStatus.OK
    );

  } catch (error) {
    console.log(error.message);
    return sendErrorResponse(res, errorEn.INTERNAL_SERVER_ERROR, HttpStatus.INTERNAL_SERVER_ERROR);
  }
};

// ✅ Add Lecture to Course
// export const addLecture = async (req, res) => {
//   try {
//     const { courseId } = req.params;
//     const { title, type, duration, isPreviewFree } = req.body;

//     if (!courseId || !title || !type) {
//       return sendErrorResponse(res, errorEn.MISSING_FIELDS, HttpStatus.BAD_REQUEST);
//     }

//     const course = await courseModel.findById(courseId);
//     if (!course) {
//       return sendErrorResponse(res, errorEn.NO_DATA_FOUND, HttpStatus.NOT_FOUND);
//     }

//     const userId = req.tokenData?.userId;
//     const userRole = req.tokenData?.role;
    
//     // ADMIN aur STREAMER dono ek dusre ke courses mein lectures add kar sakte hain
//     if (![ROLE_MAP.ADMIN, ROLE_MAP.STREAMER].includes(userRole)) {
//       return sendErrorResponse(res, "You are not authorized to add lectures to courses", HttpStatus.FORBIDDEN);
//     }

//     const fileData = req.files?.file?.[0];
//     if (!fileData) {
//       return sendErrorResponse(res, "Lecture file is required", HttpStatus.BAD_REQUEST);
//     }

//     const newLecture = {
//       title: title.trim(),
//       type: type,
//       url: fileData.location || fileData.fileUrl,
//       duration: duration ? parseInt(duration) : 0,
//       isPreviewFree: isPreviewFree === "true" || isPreviewFree === true
//     };

//     course.lectures.push(newLecture);
//     await course.save();

//     const addedLecture = course.lectures[course.lectures.length - 1];
    
//     return sendSuccessResponse(
//       res, 
//       addedLecture, 
//       "Lecture added successfully", 
//       HttpStatus.CREATED
//     );

//   } catch (error) {
//     console.error("❌ addLecture error:", error);
//     return sendErrorResponse(res, errorEn.INTERNAL_SERVER_ERROR, HttpStatus.INTERNAL_SERVER_ERROR);
//   }
// };


export const addLecture = async (req, res) => {
  console.log("===========================================");
  console.log("🎬 [ADD LECTURE] CONTROLLER START");
  
  try {
    const { courseId } = req.params;
    const { title, type, duration, isPreviewFree } = req.body;

    console.log("📌 [PARAMS] courseId:", courseId);
    console.log("📋 [BODY] Received body:", {
      title, type, duration, isPreviewFree
    });
    console.log("📦 [FILE URLS from middleware]:", req.fileUrls);
    console.log("📁 [req.files]:", req.files);

    // Validation
    if (!courseId || !title || !type) {
      console.error("❌ [VALIDATION] Missing required fields");
      return sendErrorResponse(res, errorEn.MISSING_FIELDS, HttpStatus.BAD_REQUEST);
    }

    // Find course
    console.log(`🔍 [DB] Finding course: ${courseId}`);
    const course = await courseModel.findById(courseId);
    
    if (!course) {
      console.error(`❌ [DB] Course not found: ${courseId}`);
      return sendErrorResponse(res, errorEn.NO_DATA_FOUND, HttpStatus.NOT_FOUND);
    }
    
    console.log(`✅ [DB] Course found: ${course.title}`);

    // Authorization
    const userId = req.tokenData?.userId;
    const userRole = req.tokenData?.role;
    
    console.log(`👮 [AUTH] User ID: ${userId}, Role: ${userRole}`);
    
    if (![ROLE_MAP.ADMIN, ROLE_MAP.STREAMER].includes(userRole)) {
      console.error(`❌ [AUTH] Unauthorized role: ${userRole}`);
      return sendErrorResponse(res, "You are not authorized to add lectures to courses", HttpStatus.FORBIDDEN);
    }

    // Get file URL - simplified approach
    console.log("🔗 [FILE URL] Getting file URL...");
    
    let fileUrl = null;
    
    // Option 1: Check req.fileUrls (from middleware)
    if (req.fileUrls && req.fileUrls.file && req.fileUrls.file.length > 0) {
      fileUrl = req.fileUrls.file[0].fileUrl;
      console.log("✅ [FILE URL] From req.fileUrls:", fileUrl);
    }
    // Option 2: Check req.body.file (backup)
    else if (req.body.file && Array.isArray(req.body.file) && req.body.file.length > 0) {
      fileUrl = req.body.file[0].fileUrl;
      console.log("✅ [FILE URL] From req.body.file:", fileUrl);
    }
    // Option 3: Check multer's files
    else if (req.files?.file?.[0]?.location) {
      fileUrl = req.files.file[0].location;
      console.log("✅ [FILE URL] From req.files:", fileUrl);
    }
    else {
      console.error("❌ [FILE URL] No file found in any location!");
      return sendErrorResponse(res, "Lecture file is required and must be uploaded", HttpStatus.BAD_REQUEST);
    }

    // Validate file URL
    if (!fileUrl || !fileUrl.startsWith('http')) {
      console.error("❌ [FILE URL] Invalid file URL:", fileUrl);
      return sendErrorResponse(res, "Invalid file URL generated", HttpStatus.BAD_REQUEST);
    }

    console.log("✅ [FILE URL] Final URL:", fileUrl);

    // Create lecture object
    const newLecture = {
      title: title.trim(),
      type: type,
      url: fileUrl,
      duration: duration ? parseInt(duration) : 0,
      isPreviewFree: isPreviewFree === "true" || isPreviewFree === true,
      addedBy: userId,
      addedAt: new Date()
    };

    console.log("📝 [LECTURE] Creating new lecture:", newLecture);

    // Add to course
    course.lectures.push(newLecture);
    
    console.log("💾 [DB] Saving course...");
    await course.save();
    
    const addedLecture = course.lectures[course.lectures.length - 1];
    console.log("✅ [DB] Lecture saved with ID:", addedLecture._id);

    // Verify the lecture was added
    console.log(`📚 [VERIFY] Course now has ${course.lectures.length} lectures`);
    
    console.log("✅ [ADD LECTURE] COMPLETED SUCCESSFULLY");
    console.log("===========================================");
    
    return sendSuccessResponse(
      res, 
      {
        ...addedLecture.toObject(),
        courseId: course._id,
        courseTitle: course.title
      }, 
      "Lecture added successfully", 
      HttpStatus.CREATED
    );

  } catch (error) {
    console.error("\n❌ [ADD LECTURE] ERROR");
    console.error(`💬 Message: ${error.message}`);
    console.error(`🔍 Type: ${error.name}`);
    console.error(`📋 Stack: ${error.stack}`);
    console.log("===========================================");
    
    return sendErrorResponse(res, errorEn.INTERNAL_SERVER_ERROR, HttpStatus.INTERNAL_SERVER_ERROR);
  }
};

// ✅ Remove Lecture from Course
export const removeLecture = async (req, res) => {
  try {
    const { courseId, lectureId } = req.params;

    if (!courseId || !lectureId) {
      return sendErrorResponse(res, errorEn.MISSING_FIELDS, HttpStatus.BAD_REQUEST);
    }

    const course = await courseModel.findById(courseId);
    if (!course) {
      return sendErrorResponse(res, errorEn.NO_DATA_FOUND, HttpStatus.NOT_FOUND);
    }

    const userId = req.tokenData?.userId;
    const userRole = req.tokenData?.role;
    
    // ADMIN aur STREAMER dono ek dusre ke courses se lectures remove kar sakte hain
    if (![ROLE_MAP.ADMIN, ROLE_MAP.STREAMER].includes(userRole)) {
      return sendErrorResponse(res, "You are not authorized to remove lectures from courses", HttpStatus.FORBIDDEN);
    }

    const lectureIndex = course.lectures.findIndex(
      lecture => lecture._id.toString() === lectureId
    );

    if (lectureIndex === -1) {
      return sendErrorResponse(res, "Lecture not found", HttpStatus.NOT_FOUND);
    }

    const lectureToRemove = course.lectures[lectureIndex];

    if (lectureToRemove.url) {
      await deleteFileFromS3(lectureToRemove.url);
    }

    course.lectures.splice(lectureIndex, 1);
    await course.save();

    return sendSuccessResponse(
      res, 
      null, 
      "Lecture removed successfully", 
      HttpStatus.OK
    );

  } catch (error) {
    console.error("❌ removeLecture error:", error);
    return sendErrorResponse(res, errorEn.INTERNAL_SERVER_ERROR, HttpStatus.INTERNAL_SERVER_ERROR);
  }
};

// ✅ Add Assignment to Course
export const addAssignment = async (req, res) => {
  try {
    const { courseId } = req.params;
    const { title, description, dueDate } = req.body;

    if (!courseId || !title) {
      return sendErrorResponse(res, errorEn.MISSING_FIELDS, HttpStatus.BAD_REQUEST);
    }

    const course = await courseModel.findById(courseId);
    if (!course) {
      return sendErrorResponse(res, errorEn.NO_DATA_FOUND, HttpStatus.NOT_FOUND);
    }

    const userId = req.tokenData?.userId;
    const userRole = req.tokenData?.role;
    
    // ADMIN aur STREAMER dono ek dusre ke courses mein assignments add kar sakte hain
    if (![ROLE_MAP.ADMIN, ROLE_MAP.STREAMER].includes(userRole)) {
      return sendErrorResponse(res, "You are not authorized to add assignments to courses", HttpStatus.FORBIDDEN);
    }

    const resourcesFiles = req.files?.resources || [];
    if (resourcesFiles.length === 0) {
      return sendErrorResponse(res, "At least one resource file is required", HttpStatus.BAD_REQUEST);
    }

    const resourceUrls = resourcesFiles.map(file => file.location || file.fileUrl);

    const newAssignment = {
      title: title.trim(),
      description: description || "",
      dueDate: dueDate || null,
      resources: resourceUrls
    };

    course.assignments.push(newAssignment);
    await course.save();

    const addedAssignment = course.assignments[course.assignments.length - 1];
    
    return sendSuccessResponse(
      res, 
      addedAssignment, 
      "Assignment added successfully", 
      HttpStatus.CREATED
    );

  } catch (error) {
    console.error("❌ addAssignment error:", error);
    return sendErrorResponse(res, errorEn.INTERNAL_SERVER_ERROR, HttpStatus.INTERNAL_SERVER_ERROR);
  }
};

// ✅ Remove Assignment from Course
export const removeAssignment = async (req, res) => {
  try {
    const { courseId, assignmentId } = req.params;

    if (!courseId || !assignmentId) {
      return sendErrorResponse(res, errorEn.MISSING_FIELDS, HttpStatus.BAD_REQUEST);
    }

    const course = await courseModel.findById(courseId);
    if (!course) {
      return sendErrorResponse(res, errorEn.NO_DATA_FOUND, HttpStatus.NOT_FOUND);
    }

    const userId = req.tokenData?.userId;
    const userRole = req.tokenData?.role;
    
    // ADMIN aur STREAMER dono ek dusre ke courses se assignments remove kar sakte hain
    if (![ROLE_MAP.ADMIN, ROLE_MAP.STREAMER].includes(userRole)) {
      return sendErrorResponse(res, "You are not authorized to remove assignments from courses", HttpStatus.FORBIDDEN);
    }

    const assignmentIndex = course.assignments.findIndex(
      assignment => assignment._id.toString() === assignmentId
    );

    if (assignmentIndex === -1) {
      return sendErrorResponse(res, "Assignment not found", HttpStatus.NOT_FOUND);
    }

    const assignmentToRemove = course.assignments[assignmentIndex];

    if (assignmentToRemove.resources && assignmentToRemove.resources.length > 0) {
      for (const resourceUrl of assignmentToRemove.resources) {
        await deleteFileFromS3(resourceUrl);
      }
    }

    course.assignments.splice(assignmentIndex, 1);
    await course.save();

    return sendSuccessResponse(
      res, 
      null, 
      "Assignment removed successfully", 
      HttpStatus.OK
    );

  } catch (error) {
    console.error("❌ removeAssignment error:", error);
    return sendErrorResponse(res, errorEn.INTERNAL_SERVER_ERROR, HttpStatus.INTERNAL_SERVER_ERROR);
  }
};

// // ✅ Enroll in Course
// export const enrollInCourse = async (req, res) => {
//   try {
//     const { courseId } = req.params;
//     const userId = req.tokenData?.userId;

//     if (!courseId || !userId) {
//       return sendErrorResponse(res, errorEn.MISSING_FIELDS, HttpStatus.BAD_REQUEST);
//     }

//     const course = await courseModel.findById(courseId);
//     if (!course) {
//       return sendErrorResponse(res, "Course not found", HttpStatus.NOT_FOUND);
//     }

//     const user = await authenticationModel.findById(userId);
//     if (!user) {
//       return sendErrorResponse(res, "User not found", HttpStatus.NOT_FOUND);
//     }

//     const userRoleName = ROLE_REVERSE_MAP[req.tokenData?.role];
//     if (userRoleName !== 'VIEWER') {
//       return sendErrorResponse(res, "Only VIEWER users can enroll in courses", HttpStatus.FORBIDDEN);
//     }

//     const isAlreadyEnrolled = course.enrolledUsers.some(
//       enrollment => enrollment.user && enrollment.user.toString() === userId
//     );

//     if (isAlreadyEnrolled) {
//       return sendErrorResponse(res, "You are already enrolled in this course", HttpStatus.CONFLICT);
//     }

//     course.enrolledUsers.push({
//       user: new mongoose.Types.ObjectId(userId),
//       enrolledAt: new Date(),
//       progress: 0,
//       completedLectures: [],
//       lastAccessed: new Date()
//     });

//     await course.save();

//     const io = getIO();
//     io.emit("user:enrolled", { 
//       courseId: course._id, 
//       userId: userId,
//       userName: user.name,
//       courseTitle: course.title 
//     });

//     return sendSuccessResponse(
//       res,
//       { courseId, message: "Successfully enrolled in course" },
//       "Enrolled successfully",
//       HttpStatus.OK
//     );

//   } catch (error) {
//     console.error("❌ enrollInCourse error:", error);
//     return sendErrorResponse(res, errorEn.INTERNAL_SERVER_ERROR, HttpStatus.INTERNAL_SERVER_ERROR);
//   }
// };



export const enrollInCourse = async (req, res) => {
  try {
    const { courseId } = req.params;
    const userId = req.tokenData?.userId;

    if (!courseId || !userId) {
      return sendErrorResponse(res, errorEn.MISSING_FIELDS, HttpStatus.BAD_REQUEST);
    }

    // Validate courseId
    if (!mongoose.Types.ObjectId.isValid(courseId)) {
      return sendErrorResponse(res, "Invalid course ID", HttpStatus.BAD_REQUEST);
    }

    const course = await courseModel.findById(courseId);
    if (!course) {
      return sendErrorResponse(res, "Course not found", HttpStatus.NOT_FOUND);
    }

    const user = await authenticationModel.findById(userId);
    if (!user) {
      return sendErrorResponse(res, "User not found", HttpStatus.NOT_FOUND);
    }

    const userRoleName = ROLE_REVERSE_MAP[req.tokenData?.role];
    if (userRoleName !== 'VIEWER') {
      return sendErrorResponse(res, "Only VIEWER users can enroll in courses", HttpStatus.FORBIDDEN);
    }

    const isAlreadyEnrolled = course.enrolledUsers.some(
      enrollment => enrollment.user && enrollment.user.toString() === userId
    );

    if (isAlreadyEnrolled) {
      return sendErrorResponse(res, "You are already enrolled in this course", HttpStatus.CONFLICT);
    }

    course.enrolledUsers.push({
      user: new mongoose.Types.ObjectId(userId),
      enrolledAt: new Date(),
      progress: 0,
      completedLectures: [],
      lastAccessed: new Date()
    });

    // ✅ Model में middleware की वजह से अब validation automatic होगा
    await course.save();

    const io = getIO();
    io.emit("user:enrolled", { 
      courseId: course._id, 
      userId: userId,
      userName: user.name,
      courseTitle: course.title 
    });

    return sendSuccessResponse(
      res,
      { courseId, message: "Successfully enrolled in course" },
      "Enrolled successfully",
      HttpStatus.OK
    );

  } catch (error) {
    console.error("❌ enrollInCourse error:", error);
    
    // ✅ Specific error handling
    if (error.name === 'ValidationError') {
      return sendErrorResponse(res, "Course validation failed. Please contact administrator.", HttpStatus.BAD_REQUEST);
    }
    
    return sendErrorResponse(res, errorEn.INTERNAL_SERVER_ERROR, HttpStatus.INTERNAL_SERVER_ERROR);
  }
};
// ✅ Unenroll from Course
export const unenrollFromCourse = async (req, res) => {
  try {
    const { courseId } = req.params;
    const userId = req.tokenData?.userId;

    if (!courseId || !userId) {
      return sendErrorResponse(res, errorEn.MISSING_FIELDS, HttpStatus.BAD_REQUEST);
    }

    const course = await courseModel.findById(courseId);
    if (!course) {
      return sendErrorResponse(res, "Course not found", HttpStatus.NOT_FOUND);
    }

    const enrollmentIndex = course.enrolledUsers.findIndex(
      enrollment => enrollment.user && enrollment.user.toString() === userId
    );

    if (enrollmentIndex === -1) {
      return sendErrorResponse(res, "You are not enrolled in this course", HttpStatus.NOT_FOUND);
    }

    course.enrolledUsers.splice(enrollmentIndex, 1);
    await course.save();

    const io = getIO();
    io.emit("user:unenrolled", { 
      courseId: course._id, 
      userId: userId,
      courseTitle: course.title 
    });

    return sendSuccessResponse(
      res,
      { courseId, message: "Successfully unenrolled from course" },
      "Unenrolled successfully",
      HttpStatus.OK
    );

  } catch (error) {
    console.error("❌ unenrollFromCourse error:", error);
    return sendErrorResponse(res, errorEn.INTERNAL_SERVER_ERROR, HttpStatus.INTERNAL_SERVER_ERROR);
  }
};

export const getMyEnrolledCourses = async (req, res) => {
  try {
    const userId = req.tokenData?.userId;
    const userRoleName = ROLE_REVERSE_MAP[req.tokenData?.role];

    if (!userId) {
      return sendErrorResponse(res, errorEn.UNAUTHORIZED, HttpStatus.UNAUTHORIZED);
    }

    if (userRoleName !== 'VIEWER') {
      return sendErrorResponse(res, "Only VIEWER users can view enrolled courses", HttpStatus.FORBIDDEN);
    }

    // ✅ Fetch enrolled courses excluding liveClasses and enrolledUsers
    const enrolledCourses = await courseModel.find({
      "enrolledUsers.user": userId
    })
    .populate("createdBy", "name email")
    .select("-enrolledUsers -liveClasses") // Exclude liveClasses
    .lean();

    const coursesWithEnrollmentInfo = await Promise.all(
      enrolledCourses.map(async (course) => {
        const courseDoc = await courseModel.findById(course._id);
        const enrollment = courseDoc.enrolledUsers.find(
          e => e.user && e.user.toString() === userId
        );
        
        return {
          ...course,
          enrollmentInfo: {
            enrolledAt: enrollment?.enrolledAt,
            progress: enrollment?.progress || 0,
            completedLectures: enrollment?.completedLectures?.length || 0,
            lastAccessed: enrollment?.lastAccessed
          }
        };
      })
    );

    return sendSuccessResponse(
      res,
      coursesWithEnrollmentInfo,
      "Enrolled courses fetched successfully",
      HttpStatus.OK
    );

  } catch (error) {
    console.error("❌ getMyEnrolledCourses error:", error);
    return sendErrorResponse(res, errorEn.INTERNAL_SERVER_ERROR, HttpStatus.INTERNAL_SERVER_ERROR);
  }
};

// ✅ Get Enrolled Users in a Course
export const getEnrolledUsers = async (req, res) => {
  try {
    const { courseId } = req.params;
    const userRole = req.tokenData?.role;

    if (![ROLE_MAP.ADMIN, ROLE_MAP.STREAMER].includes(userRole)) {
      return sendErrorResponse(res, errorEn.UNAUTHORIZED, HttpStatus.FORBIDDEN);
    }

    if (!courseId) {
      return sendErrorResponse(res, errorEn.MISSING_FIELDS, HttpStatus.BAD_REQUEST);
    }

    const course = await courseModel.findById(courseId)
      .populate({
        path: 'enrolledUsers.user',
        select: 'name email phone profilePic'
      })
      .select('enrolledUsers title');

    if (!course) {
      return sendErrorResponse(res, "Course not found", HttpStatus.NOT_FOUND);
    }

    const enrolledUsers = course.enrolledUsers.map(enrollment => ({
      user: enrollment.user,
      enrolledAt: enrollment.enrolledAt,
      progress: enrollment.progress,
      completedLectures: enrollment.completedLectures?.length || 0,
      lastAccessed: enrollment.lastAccessed
    }));

    return sendSuccessResponse(
      res,
      {
        courseTitle: course.title,
        totalEnrolled: enrolledUsers.length,
        enrolledUsers
      },
      "Enrolled users fetched successfully",
      HttpStatus.OK
    );

  } catch (error) {
    console.error("❌ getEnrolledUsers error:", error);
    return sendErrorResponse(res, errorEn.INTERNAL_SERVER_ERROR, HttpStatus.INTERNAL_SERVER_ERROR);
  }
};

// ✅ Update Course Progress
export const updateCourseProgress = async (req, res) => {
  try {
    const { courseId } = req.params;
    const userId = req.tokenData?.userId;
    const { progress, lectureId } = req.body;

    if (!courseId || !userId) {
      return sendErrorResponse(res, errorEn.MISSING_FIELDS, HttpStatus.BAD_REQUEST);
    }

    const course = await courseModel.findById(courseId);
    if (!course) {
      return sendErrorResponse(res, "Course not found", HttpStatus.NOT_FOUND);
    }

    const enrollmentIndex = course.enrolledUsers.findIndex(
      enrollment => enrollment.user && enrollment.user.toString() === userId
    );

    if (enrollmentIndex === -1) {
      return sendErrorResponse(res, "You are not enrolled in this course", HttpStatus.NOT_FOUND);
    }

    if (progress !== undefined) {
      const newProgress = Math.min(Math.max(parseInt(progress), 0), 100);
      course.enrolledUsers[enrollmentIndex].progress = newProgress;
    }

    if (lectureId) {
      if (!course.enrolledUsers[enrollmentIndex].completedLectures) {
        course.enrolledUsers[enrollmentIndex].completedLectures = [];
      }
      
      if (!course.enrolledUsers[enrollmentIndex].completedLectures.includes(lectureId)) {
        course.enrolledUsers[enrollmentIndex].completedLectures.push(lectureId);
      }
    }

    course.enrolledUsers[enrollmentIndex].lastAccessed = new Date();
    await course.save();

    return sendSuccessResponse(
      res,
      {
        progress: course.enrolledUsers[enrollmentIndex].progress,
        completedLectures: course.enrolledUsers[enrollmentIndex].completedLectures.length
      },
      "Progress updated successfully",
      HttpStatus.OK
    );

  } catch (error) {
    console.error("❌ updateCourseProgress error:", error);
    return sendErrorResponse(res, errorEn.INTERNAL_SERVER_ERROR, HttpStatus.INTERNAL_SERVER_ERROR);
  }
};

// ✅ Get all enrollments across all courses
export const getAllEnrollments = async (req, res) => {
  try {
    const courses = await courseModel.find()
      .populate({
        path: 'enrolledUsers.user',
        select: 'name email phone profilePic'
      })
      .populate('createdBy', 'name email')
      .select('title description category level price duration thumbnail enrolledUsers createdAt')
      .sort({ createdAt: -1 });

    let allEnrollments = [];
    let totalEnrollments = 0;
    let totalStudents = new Set();

    courses.forEach(course => {
      course.enrolledUsers.forEach(enrollment => {
        allEnrollments.push({
          enrollmentId: enrollment._id,
          courseId: course._id,
          courseTitle: course.title,
          courseDescription: course.description,
          courseThumbnail: course.thumbnail,
          courseCategory: course.category,
          courseLevel: course.level,
          coursePrice: course.price,
          courseDuration: course.duration,
          courseCreatedAt: course.createdAt,
          createdBy: course.createdBy,
          userId: enrollment.user?._id,
          userName: enrollment.user?.name,
          userEmail: enrollment.user?.email,
          userPhone: enrollment.user?.phone,
          userProfilePic: enrollment.user?.profilePic,
          enrolledAt: enrollment.enrolledAt,
          progress: enrollment.progress,
          completedLectures: enrollment.completedLectures?.length || 0,
          lastAccessed: enrollment.lastAccessed
        });
        
        totalEnrollments++;
        if (enrollment.user?._id) {
          totalStudents.add(enrollment.user._id.toString());
        }
      });
    });

    const stats = {
      totalCourses: courses.length,
      totalEnrollments,
      totalUniqueStudents: totalStudents.size,
      averageEnrollmentsPerCourse: courses.length > 0 ? (totalEnrollments / courses.length).toFixed(2) : 0,
      enrollmentByLevel: {
        beginner: courses.filter(c => c.level === 'Beginner').reduce((sum, c) => sum + c.enrolledUsers.length, 0),
        intermediate: courses.filter(c => c.level === 'Intermediate').reduce((sum, c) => sum + c.enrolledUsers.length, 0),
        advanced: courses.filter(c => c.level === 'Advanced').reduce((sum, c) => sum + c.enrolledUsers.length, 0)
      }
    };

    return sendSuccessResponse(
      res,
      {
        stats,
        enrollments: allEnrollments,
        courses: courses.map(c => ({
          _id: c._id,
          title: c.title,
          category: c.category,
          level: c.level,
          thumbnail: c.thumbnail,
          enrollments: c.enrolledUsers.length
        }))
      },
      "All enrollments fetched successfully",
      HttpStatus.OK
    );

  } catch (error) {
    console.error("❌ getAllEnrollments error:", error);
    return sendErrorResponse(res, errorEn.INTERNAL_SERVER_ERROR, HttpStatus.INTERNAL_SERVER_ERROR);
  }
};

// ✅ Admin/Streamer manually enroll a user
export const enrollUser = async (req, res) => {
  try {
    const { courseId } = req.params;
    const { userId } = req.body;
    const currentUserId = req.tokenData?.userId;
    const currentUserRole = req.tokenData?.role;

    if (!courseId || !userId) {
      return sendErrorResponse(res, errorEn.MISSING_FIELDS, HttpStatus.BAD_REQUEST);
    }

    if (![ROLE_MAP.ADMIN, ROLE_MAP.STREAMER].includes(currentUserRole)) {
      return sendErrorResponse(res, errorEn.UNAUTHORIZED, HttpStatus.FORBIDDEN);
    }

    const course = await courseModel.findById(courseId);
    if (!course) {
      return sendErrorResponse(res, "Course not found", HttpStatus.NOT_FOUND);
    }

    const user = await authenticationModel.findById(userId);
    if (!user) {
      return sendErrorResponse(res, "User not found", HttpStatus.NOT_FOUND);
    }
    
    const userRoleName = ROLE_REVERSE_MAP[user.role];
    if (userRoleName !== 'VIEWER') {
      return sendErrorResponse(res, "Only VIEWER users can be enrolled in courses", HttpStatus.BAD_REQUEST);
    }

    const isAlreadyEnrolled = course.enrolledUsers.some(
      enrollment => enrollment.user && enrollment.user.toString() === userId
    );

    if (isAlreadyEnrolled) {
      return sendErrorResponse(res, "User is already enrolled in this course", HttpStatus.CONFLICT);
    }

    course.enrolledUsers.push({
      user: new mongoose.Types.ObjectId(userId),
      enrolledAt: new Date(),
      progress: 0,
      completedLectures: [],
      lastAccessed: new Date()
    });

    await course.save();

    const io = getIO();
    io.emit("admin:user:enrolled", { 
      courseId: course._id,
      courseTitle: course.title,
      userId: userId,
      userName: user.name,
      enrolledBy: currentUserId
    });

    return sendSuccessResponse(
      res,
      { 
        courseId, 
        userId,
        userName: user.name,
        message: "User enrolled successfully" 
      },
      "User enrolled successfully",
      HttpStatus.CREATED
    );

  } catch (error) {
    console.error("❌ enrollUser error:", error);
    return sendErrorResponse(res, errorEn.INTERNAL_SERVER_ERROR, HttpStatus.INTERNAL_SERVER_ERROR);
  }
};

// ✅ Admin/Streamer unenroll a user
export const unenrollUser = async (req, res) => {
  try {
    const { courseId, userId } = req.params;
    const currentUserId = req.tokenData?.userId;
    const currentUserRole = req.tokenData?.role;

    if (!courseId || !userId) {
      return sendErrorResponse(res, errorEn.MISSING_FIELDS, HttpStatus.BAD_REQUEST);
    }

    if (![ROLE_MAP.ADMIN, ROLE_MAP.STREAMER].includes(currentUserRole)) {
      return sendErrorResponse(res, errorEn.UNAUTHORIZED, HttpStatus.FORBIDDEN);
    }

    const course = await courseModel.findById(courseId);
    if (!course) {
      return sendErrorResponse(res, "Course not found", HttpStatus.NOT_FOUND);
    }

    const enrollmentIndex = course.enrolledUsers.findIndex(
      enrollment => enrollment.user && enrollment.user.toString() === userId
    );

    if (enrollmentIndex === -1) {
      return sendErrorResponse(res, "User is not enrolled in this course", HttpStatus.NOT_FOUND);
    }

    const user = await authenticationModel.findById(userId);
    
    course.enrolledUsers.splice(enrollmentIndex, 1);
    await course.save();

    const io = getIO();
    io.emit("admin:user:unenrolled", { 
      courseId: course._id,
      courseTitle: course.title,
      userId: userId,
      userName: user?.name || 'Unknown',
      unenrolledBy: currentUserId
    });

    return sendSuccessResponse(
      res,
      { 
        courseId, 
        userId,
        userName: user?.name || 'Unknown',
        message: "User unenrolled successfully" 
      },
      "User unenrolled successfully",
      HttpStatus.OK
    );

  } catch (error) {
    console.error("❌ unenrollUser error:", error);
    return sendErrorResponse(res, errorEn.INTERNAL_SERVER_ERROR, HttpStatus.INTERNAL_SERVER_ERROR);
  }
};
import { v4 as uuidv4 } from "uuid";
import courseModel from "../../model/course/course.model.js";
import * as commonServices from "../../services/common.js";
import { sendSuccessResponse, sendErrorResponse } from "../../responses/responses.js";
import { errorEn, successEn } from "../../responses/message.js";
import { getIO } from "../../services/socket.integrated.js"; 
import { ROLE_MAP } from "../../constant/role.js";
import HttpStatus from "http-status-codes"; 

export const createCourse = async (req, res) => { 
    try {
        const {
            title,
            description,
            thumbnail,
            category,
            tags,
            level,
            price,
            language,
            duration,
            lectures,
            liveClasses,
            quizzes,
            assignments
        } = req.body;

        // ✅ Validation
        if (!title || !description || !category) {
            return sendErrorResponse(res, errorEn.MISSING_FIELDS, HttpStatus.BAD_REQUEST);
        }

        // ✅ User ko check karo (sirf mentor/admin hi bana sake course)
        const userId = req.user?._id;  
        const userRole = req.user?.role;

        if (![ROLE_MAP.ADMIN, ROLE_MAP.MENTOR].includes(userRole)) {
            return sendErrorResponse(res, errorEn.UNAUTHORIZED, HttpStatus.FORBIDDEN);
        }

        // ✅ Course create
        const newCourse = new courseModel({
            title,
            description,
            thumbnail,
            category,
            tags,
            level,
            price,
            language,
            duration,
            createdBy: userId,
            lectures,
            liveClasses,
            quizzes,
            assignments
        });

        await newCourse.save();

        const io = getIO();
        io.emit("course:created", { courseId: newCourse._id, title: newCourse.title });

        return sendSuccessResponse(
            res,
            newCourse,
            successEn.COURSE_CREATED,
            HttpStatus.CREATED
        );

    } catch (error) {
        console.log(error.message);
        return sendErrorResponse(res, errorEn.INTERNAL_SERVER_ERROR, HttpStatus.INTERNAL_SERVER_ERROR);
    }
};


export const getAllCourse = async(req,res)=>{
    try {
        
    } catch (error) {
        console.log(error.message)
        return sendErrorResponse(res, errorEn.INTERNAL_SERVER_ERROR, HttpStatus.INTERNAL_SERVER_ERROR);
    }
}
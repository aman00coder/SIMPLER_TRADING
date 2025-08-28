import { v4 as uuidv4 } from "uuid";
import courseModel from "../../model/course/course.model.js";
import * as commonServices from "../../services/common.js";
import { sendSuccessResponse, sendErrorResponse } from "../../responses/responses.js";
import { errorEn, successEn } from "../../responses/message.js";
import { getIO } from "../../services/socket.integrated.js";
import { ROLE_MAP } from "../../constant/role.js";
import HttpStatus from "http-status-codes";
import mongoose from "mongoose";

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
      tags,
      liveClasses,
      quizzes
    } = req.body;

    // ✅ Validation
    if (!title || !description || !category) {
      return sendErrorResponse(res, errorEn.MISSING_FIELDS, HttpStatus.BAD_REQUEST);
    }

    // ✅ User check
    const userId = req.tokenData?.userId;
    const userRole = req.tokenData?.role;

    if (![ROLE_MAP.ADMIN, ROLE_MAP.STREAMER].includes(userRole)) {
      return sendErrorResponse(res, errorEn.UNAUTHORIZED, HttpStatus.FORBIDDEN);
    }
    if (!userId) {
      return sendErrorResponse(res, errorEn.UNAUTHORIZED, HttpStatus.UNAUTHORIZED);
    }

    // ✅ Safe parse
    const safeParse = (value) => {
      try { return JSON.parse(value); } 
      catch { return value ? [value] : []; }
    };

    const tagsArr = safeParse(tags);
    const liveClassesArr = safeParse(liveClasses);
    const quizzesArr = safeParse(quizzes);

    // ✅ Thumbnail
    let thumbnail = null;
    if (req.body.thumbnail) {
      // middleware se object aa sakta hai ya string
      if (Array.isArray(req.body.thumbnail)) {
        thumbnail = req.body.thumbnail[0]?.fileUrl || null;
      } else if (typeof req.body.thumbnail === "object") {
        thumbnail = req.body.thumbnail.fileUrl || null;
      } else {
        thumbnail = req.body.thumbnail;
      }
    }

    // ✅ Lectures
    let lectures = [];
    if (req.body.lectures?.length) {
      lectures = req.body.lectures.map(item => ({
        title: item.title || "Untitled Lecture",
        type: item.type || (item.fileType?.includes("pdf") ? "pdf" : "video"),
        url: item.url || item.fileUrl || "",
        duration: item.duration || 0,
        isPreviewFree: item.isPreviewFree || false,
      }));
    }

    // ✅ Assignments
    let assignments = [];
    if (req.body.assignments?.length) {
      assignments = req.body.assignments.map(item => ({
        title: item.title || "Assignment",
        description: item.description || "Assignment resource",
        dueDate: item.dueDate || null,
        resources: item.resources?.length ? item.resources : (item.fileUrl ? [item.fileUrl] : [])
      }));
    }

    // ✅ Create course
    const newCourse = new courseModel({
      title: title?.trim() || null,
      description: description?.trim() || null,
      thumbnail,
      category: category?.trim() || null,
      tags: tagsArr,
      level: level?.trim() || "Beginner",
      price: price ? Number(price) : 0,
      language: language?.trim() || "English",
      duration: duration ? Number(duration) : 0,
      createdBy: new mongoose.Types.ObjectId(userId),
      lectures,
      liveClasses: liveClassesArr,
      quizzes: quizzesArr,
      assignments,
    });

    await newCourse.save();

    // ✅ Emit via socket
    const io = getIO();
    io.emit("course:created", { courseId: newCourse._id, title: newCourse.title });

    return sendSuccessResponse(res, newCourse, successEn.COURSE_CREATED, HttpStatus.CREATED);
  } catch (error) {
    console.error("❌ createCourse error:", error);
    return sendErrorResponse(res, errorEn.INTERNAL_SERVER_ERROR, HttpStatus.INTERNAL_SERVER_ERROR);
  }
};





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

export const getSingleCourse = async(req,res)=>{
    try{
        const { id } = req.params;
        if(!id){
            return sendErrorResponse(res, errorEn.MISSING_FIELDS, HttpStatus.BAD_REQUEST);
        }
        const course = await courseModel.findById(id).populate("createdBy", "name email").lean();
        if (!course) {
            return sendErrorResponse(res, errorEn.NO_DATA_FOUND, HttpStatus.NOT_FOUND);
        }
        return sendSuccessResponse(res, course, successEn.COURSE_FETCHED, HttpStatus.OK);
    } catch (error) {
        console.log(error.message)
        return sendErrorResponse(res, errorEn.INTERNAL_SERVER_ERROR, HttpStatus.INTERNAL_SERVER_ERROR); 
    }
}


export const updateCourse = async(req,res)=>{
    try{
        
    } catch (error) {
        console.log(error.message);
        return sendErrorResponse(res, errorEn.INTERNAL_SERVER_ERROR, HttpStatus.INTERNAL_SERVER_ERROR);
    }
}
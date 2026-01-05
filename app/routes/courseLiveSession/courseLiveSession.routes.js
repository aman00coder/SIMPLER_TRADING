// routes/liveSession/courseLiveSession.routes.js
import { Router } from "express";
const router = Router();
import { verifyToken, checkRole } from '../../middleware/authentication.js';
import * as courseLiveSessionController from '../../controller/courseLiveSession/courseLiveSession.controller.js';

const ADMINAuth = [verifyToken, checkRole([1])];
const STREAMERAuth = [verifyToken, checkRole([2])];
const VIEWERAuth = [verifyToken, checkRole([3])];
const ADMINSTREAMERAuth = [verifyToken, checkRole([1, 2])];
const ADMINSTREAMERVIEWERAuth = [verifyToken, checkRole([1, 2, 3])];

// ✅ CREATE SESSION (and save to course)
router.post("/create",
  ADMINSTREAMERAuth,
  courseLiveSessionController.createCourseLiveSession
);


router.get("/check-enrollment/:sessionId",
  VIEWERAuth,
  courseLiveSessionController.checkUserEnrollment
);
// ✅ JOIN SESSION
router.post("/join/:sessionId/:roomCode",
  ADMINSTREAMERVIEWERAuth,
  courseLiveSessionController.joinCourseLiveSession
);

// ✅ GET SESSION DETAILS
router.get("/:sessionId",
  ADMINSTREAMERVIEWERAuth,
  async (req, res) => {
    try {
      const { sessionId } = req.params;
      const session = await CourseLiveSession.findOne({ sessionId })
        .populate("streamerId", "name email profilePic")
        .populate("courseId", "title thumbnail");
      
      if (!session) {
        return res.status(404).json({ error: "Session not found" });
      }
      
      res.json({
        success: true,
        data: session
      });
    } catch (error) {
      res.status(500).json({ error: error.message });
    }
  }
);

// ✅ GET COURSE LIVE SESSIONS
router.get("/course/:courseId",
  ADMINSTREAMERVIEWERAuth,
  async (req, res) => {
    try {
      const { courseId } = req.params;
      const userId = req.tokenData?.userId;
      
      // Get course
      const course = await courseModel.findById(courseId);
      if (!course) {
        return res.status(404).json({ error: "Course not found" });
      }
      
      // Check enrollment
      const isEnrolled = course.enrolledUsers.some(e => e.user.toString() === userId);
      const isCreator = course.createdBy.toString() === userId;
      const isAdmin = req.tokenData?.role === ROLE_MAP.ADMIN;
      
      if (!isEnrolled && !isCreator && !isAdmin) {
        return res.status(403).json({ error: "Not enrolled in this course" });
      }
      
      // Get live sessions for this course
      const liveSessions = await CourseLiveSession.find({ 
        courseId, 
        status: "LIVE" 
      }).sort({ startTime: -1 });
      
      // Get course live classes
      const courseWithLive = await courseModel.findById(courseId)
        .select("liveClasses")
        .populate("liveClasses.mentor", "name email");
      
      res.json({
        success: true,
        data: {
          liveSessions: liveSessions,
          courseLiveClasses: courseWithLive?.liveClasses || []
        }
      });
    } catch (error) {
      res.status(500).json({ error: error.message });
    }
  }
);

// ✅ LEAVE SESSION
router.post("/leave/:sessionId",
  ADMINSTREAMERVIEWERAuth,
  async (req, res) => {
    try {
      const { sessionId } = req.params;
      const userId = req.tokenData?.userId;
      
      // Find session
      const session = await CourseLiveSession.findOne({ sessionId });
      if (!session) {
        return res.status(404).json({ error: "Session not found" });
      }
      
      // Update participant count
      await CourseLiveSession.findOneAndUpdate(
        { sessionId },
        { $inc: { participantsCount: -1 } }
      );
      
      // Update course live class count
      await courseModel.findOneAndUpdate(
        { 
          _id: session.courseId,
          "liveClasses.sessionId": sessionId
        },
        {
          $inc: { "liveClasses.$.currentParticipants": -1 }
        }
      );
      
      // Socket notification
      const io = req.app.get("io");
      if (io) {
        io.to(sessionId).emit("participant_left", {
          sessionId: sessionId,
          userId: userId,
          timestamp: new Date()
        });
      }
      
      res.json({
        success: true,
        message: "Left session successfully"
      });
    } catch (error) {
      res.status(500).json({ error: error.message });
    }
  }
);

// backend/routes/liveSession/courseLiveSession.routes.js
// Add these routes if not already present:

// ✅ GET SESSION BY ID
router.get("/:sessionId",
  ADMINSTREAMERVIEWERAuth,
  async (req, res) => {
    try {
      const { sessionId } = req.params;
      const session = await CourseLiveSession.findOne({ sessionId })
        .populate("streamerId", "name email profilePic")
        .populate("courseId", "title thumbnail");
      
      if (!session) {
        return res.status(404).json({ 
          success: false,
          message: "Session not found" 
        });
      }
      
      res.json({
        success: true,
        data: session
      });
    } catch (error) {
      res.status(500).json({ 
        success: false,
        message: error.message 
      });
    }
  }
);

// ✅ END SESSION
router.post("/end/:sessionId",
  ADMINSTREAMERAuth,
  async (req, res) => {
    try {
      const { sessionId } = req.params;
      const userId = req.tokenData?.userId;
      
      // Find session
      const session = await CourseLiveSession.findOne({ sessionId });
      if (!session) {
        return res.status(404).json({ 
          success: false,
          message: "Session not found" 
        });
      }
      
      // Check if user is the streamer
      if (session.streamerId.toString() !== userId && req.tokenData?.role !== ROLE_MAP.ADMIN) {
        return res.status(403).json({ 
          success: false,
          message: "Only the streamer can end this session" 
        });
      }
      
      // Update session status
      session.status = "ENDED";
      session.endTime = new Date();
      await session.save();
      
      // Update course live class status
      await courseModel.findOneAndUpdate(
        { 
          _id: session.courseId,
          "liveClasses.sessionId": sessionId
        },
        {
          $set: { "liveClasses.$.status": "ENDED" }
        }
      );
      
      // Socket notification
      const io = req.app.get("io");
      if (io) {
        io.to(sessionId).emit("session_ended", {
          sessionId: sessionId,
          message: "Session has ended",
          timestamp: new Date()
        });
      }
      
      res.json({
        success: true,
        message: "Session ended successfully",
        data: session
      });
    } catch (error) {
      res.status(500).json({ 
        success: false,
        message: error.message 
      });
    }
  }
);

// ✅ DELETE SESSION
router.delete("/:sessionId",
  ADMINSTREAMERAuth,
  async (req, res) => {
    try {
      const { sessionId } = req.params;
      const userId = req.tokenData?.userId;
      
      // Find session
      const session = await CourseLiveSession.findOne({ sessionId });
      if (!session) {
        return res.status(404).json({ 
          success: false,
          message: "Session not found" 
        });
      }
      
      // Check if user is the streamer
      if (session.streamerId.toString() !== userId && req.tokenData?.role !== ROLE_MAP.ADMIN) {
        return res.status(403).json({ 
          success: false,
          message: "Only the streamer can delete this session" 
        });
      }
      
      // Check if session is live
      if (session.status === "LIVE") {
        return res.status(400).json({ 
          success: false,
          message: "Cannot delete a live session. End it first." 
        });
      }
      
      // Delete from CourseLiveSession
      await CourseLiveSession.deleteOne({ sessionId });
      
      // Remove from course liveClasses
      await courseModel.findOneAndUpdate(
        { _id: session.courseId },
        {
          $pull: { 
            liveClasses: { sessionId: sessionId } 
          }
        }
      );
      
      res.json({
        success: true,
        message: "Session deleted successfully"
      });
    } catch (error) {
      res.status(500).json({ 
        success: false,
        message: error.message 
      });
    }
  }
);

export default router;
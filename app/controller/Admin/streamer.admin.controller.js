import HttpStatus from "http-status-codes";
import authenticationModel from "../../model/Authentication/authentication.model.js";
import { sendSuccessResponse, sendErrorResponse } from "../../responses/responses.js";

export const getAllStreamers = async (req, res) => {
  try {
    const streamers = await authenticationModel.find(
      { role: "STREAMER" },
      { password: 0 }
    ).sort({ createdAt: -1 });

    return sendSuccessResponse(
      res,
      { count: streamers.length, streamers },
      "Streamers fetched successfully",
      HttpStatus.OK
    );
  } catch (err) {
    return sendErrorResponse(
      res,
      "Internal server error",
      HttpStatus.INTERNAL_SERVER_ERROR
    );
  }
};

export const toggleStreamerStatus = async (req, res) => {
  try {
    const { streamerId } = req.params;
    const { isActive } = req.body; // true / false

    if (typeof isActive !== "boolean") {
      return sendErrorResponse(
        res,
        "isActive must be boolean",
        HttpStatus.BAD_REQUEST
      );
    }

    const streamer = await authenticationModel.findOneAndUpdate(
      { _id: streamerId, role: "STREAMER" },
      { isActive },
      { new: true }
    );

    if (!streamer) {
      return sendErrorResponse(
        res,
        "Streamer not found",
        HttpStatus.NOT_FOUND
      );
    }

    return sendSuccessResponse(
      res,
      {
        streamerId: streamer._id,
        isActive: streamer.isActive
      },
      isActive ? "Streamer unblocked" : "Streamer blocked",
      HttpStatus.OK
    );

  } catch (err) {
    return sendErrorResponse(
      res,
      "Internal server error",
      HttpStatus.INTERNAL_SERVER_ERROR
    );
  }
};

export const getSingleStreamer = async (req, res) => {
  try {
    const { streamerId } = req.params;

    const streamer = await authenticationModel.findOne(
      { _id: streamerId, role: "STREAMER" },
      { password: 0 }
    );

    if (!streamer) {
      return sendErrorResponse(res, "Streamer not found", 404);
    }

    return sendSuccessResponse(
      res,
      streamer,
      "Streamer fetched successfully",
      200
    );
  } catch (err) {
    return sendErrorResponse(res, "Internal server error", 500);
  }
};

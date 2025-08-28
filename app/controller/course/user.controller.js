import userModel from "../../model/course/user.model.js";
import { sendSuccessResponse, sendErrorResponse } from "../../responses/responses.js";
import { errorEn, successEn } from "../../responses/message.js";
import HttpStatus from "http-status-codes"; 

export const createUser = async (req, res) => {
    try {
        const { name, email, phone, address } = req.body;

        // ✅ Validation
        if (!name || !email || !phone || !address) {
            return sendErrorResponse(res, errorEn.MISSING_FIELDS, HttpStatus.BAD_REQUEST);
        }

        // ✅ User creation
        const newUser = new userModel({
            name,
            email,
            phone,
            address
        });

        await newUser.save();

        return sendSuccessResponse(
            res,
            newUser,
            successEn.USER_CREATED,
            HttpStatus.CREATED
        );

    } catch (error) {
        console.log(error.message);
        return sendErrorResponse(res, errorEn.INTERNAL_SERVER_ERROR, HttpStatus.INTERNAL_SERVER_ERROR);
    }
};


export const getAllUsers = async (req, res) => {
    try {
        const users = await userModel.find();
        return sendSuccessResponse(res, users, successEn.USERS_FETCHED, HttpStatus.OK);
    } catch (error) {
        console.log(error.message);
        return sendErrorResponse(res, errorEn.INTERNAL_SERVER_ERROR, HttpStatus.INTERNAL_SERVER_ERROR);
    }
};

export const updateUser = async (req, res) => {
    try {
        const { id } = req.params;
        const { name, email, phone, address } = req.body;

        // ✅ Validation
        if (!name || !email || !phone || !address) {
            return sendErrorResponse(res, errorEn.MISSING_FIELDS, HttpStatus.BAD_REQUEST);
        }

        // ✅ User update
        const updatedUser = await userModel.findByIdAndUpdate(id, {
            name,
            email,
            phone,
            address
        }, { new: true });

        if (!updatedUser) {
            return sendErrorResponse(res, errorEn.USER_NOT_FOUND, HttpStatus.NOT_FOUND);
        }

        return sendSuccessResponse(
            res,
            updatedUser,
            successEn.USER_UPDATED,
            HttpStatus.OK
        );

    } catch (error) {
        console.log(error.message);
        return sendErrorResponse(res, errorEn.INTERNAL_SERVER_ERROR, HttpStatus.INTERNAL_SERVER_ERROR);
    }
};

export const deletedUser = async (req, res) => {
    try {
        const { id } = req.params;

        // ✅ User deletion
        const deletedUser = await userModel.findByIdAndDelete(id);

        if (!deletedUser) {
            return sendErrorResponse(res, errorEn.USER_NOT_FOUND, HttpStatus.NOT_FOUND);
        }

        return sendSuccessResponse(
            res,
            deletedUser,
            successEn.USER_DELETED,
            HttpStatus.OK
        );

    } catch (error) {
        console.log(error.message);
        return sendErrorResponse(res, errorEn.INTERNAL_SERVER_ERROR, HttpStatus.INTERNAL_SERVER_ERROR);
    }
};

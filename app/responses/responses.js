import httpStatus from 'http-status-codes'

export const sendSuccessResponse = (res,data,messageType,statusCode = httpStatus.OK)=>{
    const message = messageType
    res.status(statusCode).json({
        success:true,
        message:message,
        data,
    })
}

export const sendErrorResponse = (res,messageType,statusCode=httpStatus.INTERNAL_SERVER_ERROR)=>{
    const message = messageType
    res.status(statusCode).json({
        success:false,
        message:message,
        data:[]
    })
}
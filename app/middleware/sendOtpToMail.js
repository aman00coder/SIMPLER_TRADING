import transporter from '../services/nodemailer.js';

export const tempStore = new Map();

// 🔸 Dynamic OTP Email based on profession
export const sendOtpToEmail = async (email, otp, profession = "USER") => {
    try {
        const upperProfession = profession.toUpperCase();
        const appName = "TransportEase";

        let heading = `${appName} - Account Verification`;
        let introLine = `Welcome to <strong>${appName}</strong> — your reliable transport management system.`;
        let purposeLine = `To complete your registration, use the OTP below:`;

        switch (upperProfession) {
            case "ADMIN":
                heading = `${appName} - Admin Verification`;
                purposeLine = "To complete your admin registration, use the OTP below:";
                break;
            case "DRIVER":
                heading = `${appName} - Driver Verification`;
                purposeLine = "To complete your driver registration, use the OTP below:";
                break;
            case "MUNSHI":
                heading = `${appName} - Munshi Verification`;
                purposeLine = "To complete your munshi registration, use the OTP below:";
                break;
            case "MANAGER":
                heading = `${appName} - Manager Verification`;
                purposeLine = "To complete your manager registration, use the OTP below:";
                break;
            case "FUEL PUMP":
                heading = `${appName} - Pump Operator Verification`;
                purposeLine = "To complete your fuel pump operator registration, use the OTP below:";
                break;
        }

        const mailOptions = {
            from: `"${appName} Team" <${process.env.EMAIL}>`,
            to: email,
            subject: heading,
            html: `
                <div style="font-family: Arial, sans-serif; padding: 20px; border: 1px solid #ddd; border-radius: 10px; max-width: 500px; margin: auto;">
                    <h2 style="color: #007BFF; text-align: center;">${heading}</h2>
                    <p>${introLine}</p>
                    <p>${purposeLine}</p>
                    <div style="text-align: center; font-size: 24px; font-weight: bold; color: #28a745; margin: 20px 0;">
                        ${otp}
                    </div>
                    <p>This OTP is valid for <b>10 minutes</b>.</p>
                    <hr>
                    <p style="font-size: 12px; color: #777;">Best Regards,<br>Team ${appName}</p>
                </div>
            `,
        };

        await transporter.sendMail(mailOptions);
        return { success: true, message: "OTP sent to email" };
    } catch (error) {
        console.error("Error sending OTP to email:", error);
        return { success: false, message: "Failed to send OTP to email" };
    }
};

// 🔸 Password forget OTP ✅ New
export const sendOtpForResetPassword = async (email, otp, profession = "USER") => {
  try {
    const appName = "TransportEase";
    const upperProfession = profession.toUpperCase();

    let subject = `${appName} - Password Reset`;
    let heading = `Reset Your Account Password`;
    let introLine = `We received a request to reset your password.`;
    let professionLabel = upperProfession;

    // Customize based on profession
    switch (upperProfession) {
      case "ADMIN":
        subject = `${appName} - Admin Password Reset`;
        heading = `Reset Your ADMIN Account Password`;
        professionLabel = "Admin";
        break;
      case "DRIVER":
        subject = `${appName} - Driver Password Reset`;
        heading = `Reset Your DRIVER Account Password`;
        professionLabel = "Driver";
        break;
      case "MUNSHI":
        subject = `${appName} - Munshi Password Reset`;
        heading = `Reset Your MUNSHI Account Password`;
        professionLabel = "Munshi";
        break;
      case "FUEL PUMP":
        subject = `${appName} - Fuel Pump Password Reset`;
        heading = `Reset Your FUEL PUMP Account Password`;
        professionLabel = "Fuel Pump";
        break;
      case "MANAGER":
        subject = `${appName} - Manager Password Reset`;
        heading = `Reset Your MANAGER Account Password`;
        professionLabel = "Manager";
        break;
      default:
        professionLabel = "User";
    }

    const mailOptions = {
      from: `"${appName} Team" <${process.env.EMAIL}>`,
      to: email,
      subject: subject,
      html: `
        <div style="font-family: Arial, sans-serif; padding: 20px; border: 1px solid #ddd; border-radius: 10px; max-width: 500px; margin: auto;">
          <h2 style="color: #007BFF; text-align: center;">${heading}</h2>
          <p>Dear ${professionLabel},</p>
          <p>${introLine}</p>
          <p>Use the OTP below to proceed:</p>
          <div style="text-align: center; font-size: 24px; font-weight: bold; color: #dc3545; margin: 20px 0;">
            ${otp}
          </div>
          <p>This OTP is valid for <b>10 minutes</b>.</p>
          <hr>
          <p style="font-size: 12px; color: #777;">Regards, <br> Team ${appName}</p>
        </div>
      `
    };

    await transporter.sendMail(mailOptions);
    return { success: true, message: `OTP sent to ${professionLabel}'s email` };
  } catch (error) {
    console.error(`❌ Error sending OTP to ${profession}:`, error);
    return { success: false, message: `Failed to send OTP to ${profession} email` };
  }
};


// This is just for demo purpose — prints OTP to console
export const sendOtpToPhone = async (phoneNumber, otp) => {
  console.log(`📲 Demo OTP sent to ${phoneNumber}: ${otp}`);
  return Promise.resolve(); // mimic async behavior
};


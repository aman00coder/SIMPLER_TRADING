import bcrypt from "bcryptjs";

// genPassword should be like this
export const genPassword = async (pass) => {
    try {
        const saltRound = 10;
        const salt = await bcrypt.genSalt(saltRound); 
        const genPass = await bcrypt.hash(pass, salt); 
        return genPass;
    } catch (err) {
        console.log("Error in genPassword:", err);
        return false;
    }
}


// Compare password (Async)
export const comparePass = async (plainPassword, hashPassword) => {
    try {
        console.log("Plain password:", plainPassword);  
        console.log("Hashed password from DB:", hashPassword);  
        const isMatch = await bcrypt.compare(plainPassword, hashPassword);
        console.log("Password match result:", isMatch);
        return isMatch;
    } catch (err) {
        console.log("Error in comparePass:", err);
        return false;
    }
};

import mongoose from 'mongoose';
// import { DB_URL, DB_NAME } from '../utils/constant.js';

const connectDb = async () => {
    try {

        // Connect to MongoDB Atlas
        await mongoose.connect(`${process.env.DB_URL}`);


        // // Connect to MongoDB Compass
        // const connectionString = `${DB_URL}${DB_NAME}`;
        // await mongoose.connect(connectionString, {
        //     useNewUrlParser: true,
        //     useUnifiedTopology: true,
        // });

        console.log(`\x1b[36m\x1b[1m
            
            ░▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒░
                                          \x1b[1m🚀🎉💻 MongoDB connected successfully.💻 🎉🚀
            ░▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒░
            \x1b[0m
          `);

    } catch (error) {
        console.error("❌ Database connection failed:", error.message);
        process.exit(1);
    }
};

export default connectDb;

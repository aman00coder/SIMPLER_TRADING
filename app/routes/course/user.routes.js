import { Router } from "express";
const router = Router()
import * as userController from '../../controller/course/user.controller.js';

router.route("/createUser").post(userController.createUser);
router.route("/getAllUsers").get(userController.getAllUsers);
router.route("/updateUser/:id").put(userController.updateUser);
router.route("/deleteUser/:id").delete(userController.deletedUser);


export default router;
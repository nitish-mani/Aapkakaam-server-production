const { validationResult } = require("express-validator");
const bcrypt = require("bcryptjs");
const jwt = require("jsonwebtoken");
const OtpAuth = require("../models/otpAuth");

const Employee = require("../models/employee");
const ENV = require("../src/config/env");

const secretKey = ENV.JWT_EMPLOYEE_SECRET;

//////////////////////////////
//// for employee signup ////
/////////////////////////////

exports.signup = async (req, res, next) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) {
    const error = new Error("Validation failed.");
    error.statusCode = 422;
    error.data = errors.array();
    throw error;
  }
  const name = req.body.name;
  const phoneNo = req.body.phoneNo;
  const email = req.body.email;
  const password = req.body.password;
  const validEmailId=req.body.validEmailId;
  const validPhoneNoId=req.body.validPhoneNoId;

  const regexEmail = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
  const regexPass =
    /^(?=.*[a-z])(?=.*[A-Z])(?=.*\d)(?=.*[@$!%*?&#])[A-Za-z\d@$!%*?&#]{8,}$/;

  if (!regexEmail.test(email)) {
    return res.status(401).json({ message: "Invalid Email" });
  }
  if (!regexPass.test(password)) {
    return res.status(401).json({
      message:
        "Password must be at least 8 characters long and contain at least one uppercase letter, one lowercase letter, one number, and one special character",
    });
  }

  const [checkPhoneNoValid, checkEmailValid] = await Promise.all([
    OtpAuth.findById(validPhoneNoId).select("verifiedNumber"),
    OtpAuth.findById(validEmailId).select("verifiedEmail"),
  ]);
  const verifiedEmail = checkEmailValid?.verifiedEmail;
  const verifiedNumber = checkPhoneNoValid?.verifiedNumber;

  if (!checkPhoneNoValid || !checkPhoneNoValid.verifiedNumber) {
    return res.status(401).json({ message: "Number not verified" });
  }

  if (!checkEmailValid || !checkEmailValid.verifiedEmail) {
    return res.status(401).json({ message: "Email not verified" });
  }

  Employee.findOne({ email: email }).then((resuslt) => {
    if (resuslt?.email)
      return res.status(401).json({ message: "Email already exist !" });
    bcrypt
      .hash(password, 12)
      .then((hashedPw) => {
        const employee = new Employee({
          name: name,
          phoneNo: phoneNo,
          email: email,
          password: hashedPw,
          verifyEmail:verifiedEmail,
          verifyPhoneNo:verifiedNumber,
        });
        return employee.save();
      })
      .then((result) => {
        res
          .status(201)
          .json({ message: "Employee created!", employeeId: result._id });
      })
      .catch((err) => {
        if (!err.statusCode) {
          err.statusCode = 500;
        }
        next(err);
      });
  });
};

///////////////////////////////
//// for employee login //////
/////////////////////////////

exports.login = (req, res, next) => {
  const email = req.body.email;
  const password = req.body.password;
  let loadedEmployee;
  Employee.findOne({ email: email })
    .then((employee) => {
      if (!employee) {
        const error = new Error("A employee with this email could not found.");
        error.statusCode = 401;
        throw error;
      }
      loadedEmployee = employee;
      return bcrypt.compare(password, employee.password);
    })
    .then((isEqual) => {
      if (!isEqual) {
        const error = new Error("Wrong password!");
        error.statusCode = 401;
        throw error;
      }
      const token = jwt.sign(
        {
          email: loadedEmployee.email,
          employeeId: loadedEmployee._id.toString(),
        },
        secretKey,
        { expiresIn: "72h" }
      );
      res.status(200).json({
        token: token,
        employeeId: loadedEmployee._id,
        name: loadedEmployee.name,
        email: loadedEmployee.email,
        verifyEmail: loadedEmployee.verifyEmail,
        phoneNo: loadedEmployee.phoneNo,
        verifyPhoneNo: loadedEmployee.verifyPhoneNo,
        balance: loadedEmployee.balance,
        address: loadedEmployee.address,
        gender: loadedEmployee.gender,
        message: "Employee logged In Successfully ",
      });
    })
    .catch((err) => {
      if (!err.statusCode) {
        err.statusCode = 500;
      }
      next(err);
    });
};

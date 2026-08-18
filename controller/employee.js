const Employee = require("../models/employee");

const { default: axios } = require("axios");
const OtpAuth = require("../models/otpAuth");
const bcrypt = require("bcryptjs");
const { ObjectId } = require("mongodb");
const { getTransporter, getFromAddress } = require("../src/config/mailer");

const otp = () => Math.floor(Math.random() * (999999 - 100000 + 1)) + 100000;

////////////////////////////////////
///// for Email Verification //////
//////////////////////////////////

exports.employee_controller_verify_email = (req, res, next) => {
  const otpE = otp();
  const email = req.body.email;
  const otpId = req.body.otpId;

  // Function to send OTP via email

  OtpAuth.findById(otpId)
    .then((result) => {
      const otp = new OtpAuth({
        otp: otpE,
      });
      return otp.save().then((result) => {
        const transporter = getTransporter();

        function sendOTP(email, otp) {
          const mailOptions = {
            from: getFromAddress(),
            to: email,
            subject: "OTP Verification",
            text: `Your OTP for email verification is: ${otp}`,
          };

          transporter.sendMail(mailOptions, function (error, info) {
            if (error) {
              res.json(error);
            } else {
              res.status(200).json({
                message: "OTP sent on Email",
                verified: true,
                otpId: result._id,
              });
            }
          });
        }
        sendOTP(email, otpE);
      });
    })
    .catch((err) => res.json(err));
};

exports.employee_controller_otpE = (req, res, next) => {
  const userOtp = req.body.emailOtp;
  const otpId = req.body.otpId;

  OtpAuth.findById(otpId)
    .then((result) => {
      if (result.otp == userOtp) {
        OtpAuth.findByIdAndUpdate(
          otpId,
          {
            verifiedEmail: true,
          },
          { returnDocument: "after" }
        ).then((result) => res.json({ message: "OTP verified", verify: true }));
      } else {
        res.json({ message: "invalid OTP", verify: false });
      }
    })
    .catch((err) => {
      res.status(404).json({ message: "Not authorized" });
    });
};

////////////////////////////////////////////
///// for Mobile Number Verification //////
//////////////////////////////////////////

exports.employee_controller_verify_phoneNo = (req, res, next) => {
  const otpM = otp();
  const phoneNo = req.body.phoneNo;
  const otpId = req.body.otpId;

  OtpAuth.findById(otpId)
    .then((result) => {
      const otp = new OtpAuth({
        otp: otpM,
      });
      return otp.save().then((result) => {
        axios
          .get(
            `${process.env.FAST2SMS}&route=otp&variables_values=${otpM}&flash=0&numbers=${phoneNo}`
          )
          .then((succ) =>
            res.status(200).json({
              message: "OTP sent successfully",
              verified: true,
              otpId: result._id,
            })
          );
      });
    })
    .catch((err) => res.status(400).send(err));
};

exports.employee_controller_otp = (req, res, next) => {
  const userOtp = req.body.otp;
  const otpId = req.body.otpId;

  OtpAuth.findById(otpId)
    .then((result) => {
      if (result.otp == userOtp) {
        OtpAuth.findByIdAndUpdate(
          otpId,
          { verifiedNumber: true },
          { returnDocument: "after" }
        ).then((result) => res.json({ message: "OTP verified", verify: true }));
      } else {
        res.json({ message: "invalid OTP", verify: false });
      }
    })
    .catch((err) => res.status(404).json({ message: "Not authorized" }));
};

///////////////////////////////////////
//// for updating employee password //////
///////////////////////////////////////

exports.employee_controller_patch_password = (req, res, next) => {
  const password = req.body.password;
  const email = req.body.email;
  const otpId = req.body.otpId;
  OtpAuth.findById(otpId)
    .then((result) => {
      if (result?.verifiedEmail)
        bcrypt
          .hash(password, 12)
          .then((hashPass) => {
            Employee.findOneAndUpdate(
              { email: email },
              { password: hashPass },
              { returnDocument: "after" }
            ).then((result) => {
              res
                .status(201)
                .json({ message: "password changed successfully" });
            });
          })
          .catch((err) =>
            res
              .status(404)
              .json({ message: "employee with this Email Not found" })
          );
      else {
        res.status(404).json({ message: "Not verified employee" });
      }
    })
    .catch((err) => {
      res.status(404).json({ message: "Not Authorized" });
    });
};

///////////////////////////////////////
///// for updating employee address //////
//////////////////////////////////////

exports.employee_controller_patch_address = (req, res, next) => {
  const employeeId = req.body.employeeId;

  const vill = req.body.vill;
  const post = req.body.post;
  const dist = req.body.dist;
  const state = req.body.state;
  const pincode = req.body.pincode;

  let loadedEmployee;
  Employee.findByIdAndUpdate(
    employeeId,
    { address: { vill, post, dist, state, pincode }, pincode: pincode },
    { returnDocument: "after" }
  )
    .then((result) => {
      if (!result) {
        const error = new Error("Could not find Employee.");
        error.statusCode = 404;
        throw error;
      }
      loadedEmployee = result;

      res.status(200).json({
        address: loadedEmployee.address,
        message: "Address Updated Successfully ",
      });
    })
    .catch((err) => {
      if (!err.statusCode) {
        err.statusCode = 500;
      }
      next(err);
    });
};

///////////////////////////////////////
///// for modifing employee name //////
//////////////////////////////////////

exports.employee_controller_patch_name = (req, res, next) => {
  const name = req.body.name;
  const employeeId = req.body.employeeId;
  let loadedEmployee;
  Employee.findByIdAndUpdate(employeeId, { name }, { returnDocument: "after" })
    .then((result) => {
      if (!result) {
        const error = new Error("Could not find Employee.");
        error.statusCode = 404;
        throw error;
      }
      loadedEmployee = result;
      res.status(200).json({
        name: loadedEmployee.name,
        message: "Name Updated Successfully ",
      });
    })
    .catch((err) => {
      if (!err.statusCode) {
        err.statusCode = 500;
      }
      next(err);
    });
};

///////////////////////////////////////
///// for modifing employee phoneNo //////
//////////////////////////////////////

exports.employee_controller_patch_phoneNo = (req, res, next) => {
  const phoneNo = req.body.phoneNo;
  const employeeId = req.body.employeeId;
  const otpId = req.body.otpId;
  let loadedEmployee;
  OtpAuth.findById(otpId)
    .then((result) => {
      if (result?.verifiedNumber)
        Employee.findByIdAndUpdate(
          employeeId,
          { phoneNo },
          { returnDocument: "after" }
        )
          .then((result) => {
            if (!result) {
              const error = new Error("Could not find Employee.");
              error.statusCode = 404;
              throw error;
            }
            loadedEmployee = result;
            res.status(200).json({
              phoneNo: loadedEmployee.phoneNo,
              message: "Phone Number Updated Successfully ",
            });
          })
          .catch((err) => {
            if (!err.statusCode) {
              err.statusCode = 500;
            }
            next(err);
          });
      else {
        res.status(404).json({ message: "Not Verified employee" });
      }
    })
    .catch((err) => {
      res.status(404).json({ message: "Not Authorized" });
    });
};
///////////////////////////////////////
///// for modifing employee email //////
//////////////////////////////////////

exports.employee_controller_patch_email = (req, res, next) => {
  const email = req.body.email;
  const employeeId = req.body.employeeId;
  const otpId = req.body.otpId;
  let loadedEmployee;
  OtpAuth.findById(otpId)
    .then((result) => {
      if (result?.verifiedEmail)
        Employee.findByIdAndUpdate(
          employeeId,
          { email },
          { returnDocument: "after" }
        )
          .then((result) => {
            if (!result) {
              const error = new Error("Could not find Employee.");
              error.statusCode = 404;
              throw error;
            }
            loadedEmployee = result;
            res.status(200).json({
              email: loadedEmployee.email,
              message: "Email Updated Successfully ",
            });
          })
          .catch((err) => {
            if (!err.statusCode) {
              err.statusCode = 500;
            }
            next(err);
          });
      else {
        res.status(404).json({ message: "Not Verified employee" });
      }
    })
    .catch((err) => {
      res.status(404).json({ message: "Not Authorized" });
    });
};

///////////////////////////////////////
///// for getting employee share //////
//////////////////////////////////////

exports.employee_controller_getShare = (req, res, next) => {
  const employeeId = req.params.employeeId;
  const date = parseInt(req.params.date);
  const month = parseInt(req.params.month);
  const year = parseInt(req.params.year);

  Employee.aggregate([
    {
      $match: {
        _id: new ObjectId(employeeId), // Assuming you're using Mongoose
      },
    },
    {
      $unwind: "$share", // Deconstructing the array field 'share'
    },
    {
      $match: {
        "share.date": date,
        "share.month": month,
        "share.year": year,
      },
    },
    {
      $group: {
        _id: "$_id",
        share: { $push: "$share" },
      },
    },
  ])
    .then((result) => {
      if (!result || result.length === 0) {
        return res.status(200).json({ share: [] });
      }
      res.status(200).json({ share: result[0].share });
    })
    .catch((err) => {
      if (!err.statusCode) {
        err.statusCode = 500;
      }
      next(err);
    });
};

///////////////////////////////////////
///// for getting employee attendence //////
//////////////////////////////////////

exports.employee_controller_getAttendence = (req, res, next) => {
  const employeeId = req.params.employeeId;
  const month = parseInt(req.params.month);
  const year = parseInt(req.params.year);

  Employee.aggregate([
    {
      $match: {
        _id: new ObjectId(employeeId), // Assuming you're using Mongoose
      },
    },
    {
      $unwind: "$share", // Deconstructing the array field 'share'
    },
    {
      $match: {
        "share.month": month,
        "share.year": year,
      },
    },
    {
      $group: {
        _id: "$_id",
        share: { $push: "$share" },
      },
    },
  ])
    .then((result) => {
      if (!result || result.length === 0) {
        return res.status(200).json({ attendence: [] });
      }
      res.status(200).json({ attendence: result[0].share });
    })
    .catch((err) => {
      if (!err.statusCode) {
        err.statusCode = 500;
      }
      next(err);
    });
};

///////////////////////////////////////
///// for getting employee by employee //////
//////////////////////////////////////

exports.employee_controller_getEmployee = (req, res, next) => {
  const employeeId = req.params.employeeId;
  let loadedEmployee;
  Employee.findOne({ _id: employeeId })

    .then((result) => {
      if (!result) {
        const error = new Error("Could not find Employee.");
        error.statusCode = 404;
        throw error;
      }
      loadedEmployee = result;
      res.status(200).json({
        balance: loadedEmployee.balance,
      });
    })
    .catch((err) => {
      if (!err.statusCode) {
        err.statusCode = 500;
      }
      next(err);
    });
};

///////////////////////////////////////////////////////////////////////
//// for getting user which are present in orderlist of vendor  //////
//////////////////////////////////////////////////////////////////////

exports.employee_controller_getOne = async (req, res, next) => {
  const employeeId = req.params.employeeId;
  Employee.findOne({ _id: employeeId })
    .then((result) => {
      if (!result) {
        const error = new Error("Could not find Employee.");
        error.statusCode = 404;
        throw error;
      }
      res.json(result);
    })
    .catch((err) => {
      if (!err.statusCode) {
        err.statusCode = 500;
      }
      next(err);
    });
};

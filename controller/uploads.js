"use strict";

const { S3Client, PutObjectCommand } = require("@aws-sdk/client-s3");
const { getSignedUrl } = require("@aws-sdk/s3-request-presigner");

const User = require("../models/user");
const Vendor = require("../models/vendor");

const ApiError = require("../src/utils/ApiError");
const asyncHandler = require("../src/utils/asyncHandler");
const logger = require("../src/config/logger");

/*
 * ============================================================
 * S3 CONFIGURATION
 * ============================================================
 *
 * DO NOT hard-code AWS credentials here.
 *
 * AWS SDK credential resolution can use:
 *
 * - IAM role (recommended on EC2)
 * - AWS_ACCESS_KEY_ID / AWS_SECRET_ACCESS_KEY
 * - ~/.aws/credentials in development
 *
 * If this application runs on EC2, prefer an IAM role.
 */

const AWS_REGION = process.env.AWS_REGION || "ap-south-1";
const S3_BUCKET = process.env.AWS_S3_BUCKET || "aapkakaam";

const s3Client = new S3Client({
  region: AWS_REGION,
});

/*
 * ============================================================
 * HELPERS
 * ============================================================
 */

/**
 * Validate that the authenticated principal is operating only
 * on its own account and account category.
 *
 * Security rule:
 *
 * User JWT:
 *   category must be "user"
 *   id must equal req.auth.id
 *
 * Vendor JWT:
 *   category must be "vendor"
 *   id must equal req.auth.id
 */
function authorizeUploadTarget(req) {
  if (!req.auth?.id || !req.auth?.role) {
    throw ApiError.unauthorized("Authentication required.");
  }

  const authenticatedId = String(req.auth.id);
  const requestedId = String(req.params.id || "");
  const requestedCategory = String(req.params.category || "").toLowerCase();
  const authenticatedRole = String(req.auth.role).toLowerCase();

  /*
   * Only supported account categories.
   */
  if (!["user", "vendor"].includes(requestedCategory)) {
    throw ApiError.badRequest("Invalid upload category.");
  }

  /*
   * Prevent cross-role attacks:
   *
   * User JWT   -> vendor category
   * Vendor JWT -> user category
   */
  if (requestedCategory !== authenticatedRole) {
    throw ApiError.forbidden("You are not authorized to upload for this account type.");
  }

  /*
   * Prevent IDOR:
   *
   * User A JWT   -> User B ID
   * Vendor A JWT -> Vendor B ID
   */
  if (requestedId !== authenticatedId) {
    throw ApiError.forbidden("You are not authorized to upload for this account.");
  }

  return {
    id: authenticatedId,
    category: authenticatedRole,
  };
}

/**
 * Build the canonical S3 object key.
 */
function buildObjectKey(category, id) {
  return `uploads/${category}/img${id}.jpeg`;
}

/**
 * Build public image URL.
 *
 * If you later move images behind CloudFront, change this
 * helper instead of changing every controller.
 */
function buildPublicUrl(category, id) {
  return `https://${S3_BUCKET}.s3.${AWS_REGION}.amazonaws.com/${buildObjectKey(category, id)}`;
}

/**
 * Generate presigned PUT URL.
 */
async function createUploadUrl(category, id) {
  const command = new PutObjectCommand({
    Bucket: S3_BUCKET,
    Key: buildObjectKey(category, id),
    ContentType: "image/jpeg",
  });

  return getSignedUrl(s3Client, command, {
    expiresIn: 600,
  });
}

/*
 * ============================================================
 * GENERATE PRESIGNED UPLOAD URL
 * ============================================================
 */

exports.uploads = asyncHandler(async (req, res) => {
  /*
   * Never trust params directly.
   *
   * authorizeUploadTarget() verifies that:
   *
   * req.params.id       === req.auth.id
   * req.params.category === req.auth.role
   */
  const { id, category } = authorizeUploadTarget(req);

  const url = await createUploadUrl(category, id);

  logger.info(
    {
      authId: id,
      role: category,
      objectKey: buildObjectKey(category, id),
    },
    "S3 upload URL generated",
  );

  res.status(200).json({
    urlForUploads: url,
  });
});

/*
 * ============================================================
 * COMMIT PROFILE IMAGE
 * ============================================================
 */

exports.getUploads = asyncHandler(async (req, res) => {
  /*
   * Perform the authorization check BEFORE touching MongoDB.
   */
  const { id, category } = authorizeUploadTarget(req);

  const url = buildPublicUrl(category, id);

  let account;

  if (category === "user") {
    account = await User.findByIdAndUpdate(
      id,
      {
        $set: {
          imgURL: url,
        },
      },
      {
        new: true,
        runValidators: true,
      },
    )
      .select("_id imgURL")
      .lean();
  } else {
    account = await Vendor.findByIdAndUpdate(
      id,
      {
        $set: {
          imgURL: url,
        },
      },
      {
        new: true,
        runValidators: true,
      },
    )
      .select("_id imgURL")
      .lean();
  }

  if (!account) {
    throw ApiError.notFound(category === "user" ? "User not found." : "Vendor not found.");
  }

  logger.info(
    {
      authId: id,
      role: category,
      objectKey: buildObjectKey(category, id),
    },
    "Profile image updated",
  );

  res.status(200).json({
    message: "Done..",
    imgURL: account.imgURL,
  });
});

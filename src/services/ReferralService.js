const User = require("../../models/user");
const Vendor = require("../../models/vendor");

const REFERRAL = Object.freeze({
  MIN_COMPLETED_BOOKINGS: 5,
  COMMISSION_PERCENTAGE: 0.05,
});

async function getEntity(entityId, entityType, session = null) {
  let model;

  switch (entityType) {
    case "user":
      model = User;
      break;

    case "vendor":
      model = Vendor;
      break;

    default:
      throw new Error(`Invalid entity type : ${entityType}`);
  }

  return model
    .findById(entityId)
    .select("cd shareBy completed completedVendor")
    .session(session);
}

function getReferrerModel(cd) {
  switch (cd) {
    case "user":
      return User;

    case "vendor":
      return Vendor;

    default:
      throw new Error(`Invalid referral source : ${cd}`);
  }
}

async function markPending(entityId, entityType, session = null) {
  const entity = await getEntity(entityId, entityType, session);

  if (!entity || !entity.shareBy) return;

  const Referrer = getReferrerModel(entity.cd);

  await Referrer.findByIdAndUpdate(
    entity.shareBy,

    {
      $inc: {
        pendingShareBy: 1,
      },
    },

    {
      session,
    },
  );
}

async function markCancelled(entityId, entityType, session = null) {
  const entity = await getEntity(entityId, entityType, session);

  if (!entity || !entity.shareBy) return;

  const Referrer = getReferrerModel(entity.cd);

  await Referrer.findByIdAndUpdate(
    entity.shareBy,

    {
      $inc: {
        pendingShareBy: -1,

        canceledShareBy: 1,
      },
    },

    {
      session,
    },
  );
}

async function markCompleted(
  entityId,
  entityType,
  commission,
  averageDiscount = 1,
  session = null,
) {
  const entity = await getEntity(entityId, entityType, session);

  if (!entity || !entity.shareBy) return;

  const Referrer = getReferrerModel(entity.cd);

  const completedCount =
    entityType === "vendor" ? entity.completedVendor : entity.completed;

  const update = {
    pendingShareBy: -1,

    completedShareBy: 1,
  };

  if (completedCount >= REFERRAL.MIN_COMPLETED_BOOKINGS) {
    update.earning =
      commission * REFERRAL.COMMISSION_PERCENTAGE * averageDiscount;
  }

  await Referrer.findByIdAndUpdate(
    entity.shareBy,

    {
      $inc: update,
    },

    {
      session,
    },
  );
}

module.exports = {
  markPending,

  markCancelled,

  markCompleted,
};

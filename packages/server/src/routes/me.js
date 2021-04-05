const express = require("express");
const app = express.Router();
const session = require("../middleware/session");
const user = require("../middleware/user");
const validation = require("../middleware/validation");
const Joi = require("joi");

app.post(
  "/",
  session,
  user,
  validation(
    Joi.object({
      name: Joi.string()
        .min(1)
        .max(32),
      username: Joi.string()
        .min(3)
        .max(32)
        .alphanum(),
      salt: Joi.string()
        .length(24)
        .base64(),
      authKey: Joi.string()
        .length(44)
        .base64(),
      oldAuthKey: Joi.string()
        .length(44)
        .base64(),
      encryptedPrivateKey: Joi.string()
        .length(96)
        .base64(),
      accentColor: Joi.string()
        .required()
        .valid("green", "red", "yellow", "blue", "indigo", "purple", "pink"),
    })
  ),
  async (req, res) => {
    if (
      req.body.username &&
      (await req.deps.db.collection("users").findOne({
        username: req.body.username,
      }))
    ) {
      return res.status(400).json({
        error: "Username already in use.",
      });
    }

    const passwordChangeKeywords = [
      "salt",
      "authKey",
      "oldAuthKey",
      "encryptedPrivateKey",
    ].filter((a) => a in req.body).length;

    if (passwordChangeKeywords === 4) {
      req.body.salt = Buffer.from(req.body.salt, "base64");
      req.body.authKey = Buffer.from(req.body.authKey, "base64");
      req.body.oldAuthKey = Buffer.from(req.body.oldAuthKey, "base64");
      req.body.encryptedPrivateKey = Buffer.from(
        req.body.encryptedPrivateKey,
        "base64"
      );

      if (req.user.authKey.buffer.compare(req.body.oldAuthKey)) {
        res.status(400).json({
          error: "Invalid password",
        });

        return;
      }

      //fields that should not be saved in the db under the user.
      delete req.body.oldAuthKey;
    } else if (passwordChangeKeywords) {
      res.status(400).json({
        error: "Invalid data for setting password.",
      });

      return;
    }

    await req.deps.db.collection("users").updateOne(req.user, {
      $set: req.body,
    });

    res.end();

    //fields that should not be exposed to other users.
    //or the user in general (via the $store.state.user object).
    delete req.body.salt;
    delete req.body.authKey;
    delete req.body.encryptedPrivateKey;

    if (Object.keys(req.body).length) {
      req.deps.redis.publish(`user:${req.session.user}`, {
        t: "user",
        d: req.body,
      });
    }

    //fields that should not be exposed outside of the current user.
    delete req.body.accentColor;

    //propegate changes to friends
    const friends = await (
      await req.deps.db.collection("friends").find({
        $or: [
          {
            initiator: req.session.user,
          },
          {
            target: req.session.user,
          },
        ],
      })
    ).toArray();

    for (const friend of friends) {
      let userId;

      if (friend.initiator.equals(req.session.user)) {
        userId = friend.target;
      }

      if (friend.target.equals(req.session.user)) {
        userId = friend.initiator;
      }

      await req.deps.redis.publish(`user:${userId}`, {
        t: "friendUser",
        d: {
          friend: friend._id.toString(),
          ...req.body,
        },
      });
    }

    //propegate changes to channels
    const channels = await (
      await req.deps.db.collection("channels").find({
        users: {
          $elemMatch: {
            id: req.session.user,
            removed: false,
          },
        },
      })
    ).toArray();

    for (const channel of channels) {
      for (const channelUser of channel.users
        .filter((u) => !u.removed)
        .filter((u) => !u.id.equals(req.session.user))) {
        await req.deps.redis.publish(`user:${channelUser.id}`, {
          t: "channelUser",
          d: {
            channel: channel._id.toString(),
            id: req.session.user.toString(),
            ...req.body,
          },
        });
      }
    }
  }
);

module.exports = app;

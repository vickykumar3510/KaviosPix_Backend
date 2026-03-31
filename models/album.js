const mongoose = require("mongoose");

const albumSchema = new mongoose.Schema(
  {
    albumId: {
      type: String,
      required: true,
      unique: true,
    },
    name: {
      type: String,
      required: true,
      trim: true,
    },
    description: {
      type: String,
      default: "",
      trim: true,
    },
    ownerId: {
      type: String,
      required: true,
    },
    sharedWith: {
      type: [String],
      default: [],
    },
  },
  {
    timestamps: true,
  }
);

const Album = mongoose.model("Album", albumSchema);

module.exports = { Album };
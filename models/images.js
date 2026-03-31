const mongoose = require("mongoose");

const imageSchema = new mongoose.Schema(
  {
    imageId: {
      type: String,
      required: true,
      unique: true,
    },
    albumId: {
      type: String,
      required: true,
    },
    name: {
      type: String,
      required: true,
    },
    filePath: {
      type: String,
      required: true,
    },
    mimeType: {
      type: String,
      default: "",
    },
    tags: {
      type: [String],
      default: [],
    },
    person: {
      type: String,
      default: "",
    },
    isFavorite: {
      type: Boolean,
      default: false,
    },
    comments: {
      type: [String],
      default: [],
    },
    size: {
      type: Number,
      required: true,
    },
    sizeMB: {
      type: Number,
      required: true,
    },
    uploadedAt: {
      type: Date,
      default: Date.now,
    },
  },
  {
    timestamps: true,
  }
);

const Image = mongoose.model("Image", imageSchema);

module.exports = { Image };
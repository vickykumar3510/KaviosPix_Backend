const express = require("express");
const cors = require("cors");
const multer = require("multer");
const path = require("path");
const jwt = require("jsonwebtoken");
const axios = require("axios");
const fs = require("fs");
const { v4: uuidv4 } = require("uuid");
require("dotenv").config();

const { initializeDatabase } = require("./db/db.connect");
const { User } = require("./models/users");
const { Album } = require("./models/album");
const { Image } = require("./models/images");

const app = express();
const PORT = process.env.PORT || 3000;

function getAllowedFrontendOrigins() {
  return String(process.env.FRONTEND_URLS || process.env.FRONTEND_URL || "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
}

function isAllowedFrontendOrigin(origin) {
  if (!origin) return false;
  const allowed = getAllowedFrontendOrigins();
  return allowed.includes(origin);
}

function getRequestFrontendOrigin(req) {
  // Prefer explicit query (useful for local dev), otherwise use Origin/Referer.
  const fromQuery = typeof req.query.frontend === "string" ? req.query.frontend : null;
  if (fromQuery && isAllowedFrontendOrigin(fromQuery)) return fromQuery;

  const origin = req.get("origin");
  if (origin && isAllowedFrontendOrigin(origin)) return origin;

  const referer = req.get("referer");
  if (referer) {
    try {
      const parsed = new URL(referer);
      const refererOrigin = parsed.origin;
      if (isAllowedFrontendOrigin(refererOrigin)) return refererOrigin;
    } catch {
      // ignore
    }
  }

  return null;
}

function getBackendBaseUrl(req) {
  // Works for local dev + behind proxies (Render/Vercel/etc).
  const proto = req.get("x-forwarded-proto") || req.protocol;
  const host = req.get("x-forwarded-host") || req.get("host");
  if (proto && host) return `${proto}://${host}`;
  return process.env.BACKEND_URL;
}

app.use(
  cors({
    origin: (origin, callback) => {
      // allow non-browser clients (no Origin header)
      if (!origin) return callback(null, true);
      return isAllowedFrontendOrigin(origin)
        ? callback(null, true)
        : callback(new Error("Not allowed by CORS"));
    },
    credentials: true,
  })
);
app.use(express.json());
app.use("/uploads", express.static("uploads"));

initializeDatabase();

function generateToken(user) {
  return jwt.sign(
    {
      userId: user.userId,
      email: user.email,
    },
    process.env.JWT_SECRET,
    { expiresIn: "7d" }
  );
}

function authenticateToken(req, res, next) {
  const authHeader = req.headers.authorization;
  const token = authHeader?.startsWith("Bearer ")
    ? authHeader.split(" ")[1]
    : null;

  if (!token) {
    return res.status(401).json({ error: "Access denied. No token provided." });
  }

  try {
    const decoded = jwt.verify(token, process.env.JWT_SECRET);
    req.user = decoded;
    next();
  } catch (error) {
    return res.status(403).json({ error: "Invalid or expired token." });
  }
}

async function getAlbumWithAccess(albumId, user) {
  return await Album.findOne({
    albumId,
    $or: [{ ownerId: user.userId }, { sharedWith: user.email }],
  });
}

async function getOwnedAlbum(albumId, user) {
  return await Album.findOne({
    albumId,
    ownerId: user.userId,
  });
}

const upload = multer({
  dest: "uploads/",
  limits: { fileSize: 5 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    const ext = path.extname(file.originalname).toLowerCase();
    const allowed = [".jpg", ".jpeg", ".png", ".gif", ".webp"];
    if (!allowed.includes(ext)) {
      return cb(new Error("Only image files are allowed."));
    }
    cb(null, true);
  },
});

app.get("/", (req, res) => {
  res.send("API is working");
});

// Google OAuth

app.get("/auth/google", (req, res) => {
  const redirectUri = `${getBackendBaseUrl(req)}/auth/google/callback`;
  const frontendOrigin = getRequestFrontendOrigin(req);
  const state = frontendOrigin ? encodeURIComponent(frontendOrigin) : "";

  const googleAuthUrl =
    `https://accounts.google.com/o/oauth2/v2/auth?` +
    `client_id=${process.env.GOOGLE_CLIENT_ID}&` +
    `redirect_uri=${encodeURIComponent(redirectUri)}&` +
    `response_type=code&` +
    `scope=${encodeURIComponent("openid email profile")}&` +
    `access_type=offline&prompt=consent` +
    (state ? `&state=${state}` : "");

  res.redirect(googleAuthUrl);
});

app.get("/auth/google/callback", async (req, res) => {
  try {
    const { code, state } = req.query;

    if (!code) {
      return res.status(400).send("Authorization code not provided.");
    }

    const redirectUri = `${getBackendBaseUrl(req)}/auth/google/callback`;

    const params = new URLSearchParams();
    params.append("client_id", process.env.GOOGLE_CLIENT_ID);
    params.append("client_secret", process.env.GOOGLE_CLIENT_SECRET);
    params.append("code", code);
    params.append("grant_type", "authorization_code");
    params.append("redirect_uri", redirectUri);

    const tokenResponse = await axios.post(
      "https://oauth2.googleapis.com/token",
      params.toString(),
      {
        headers: {
          "Content-Type": "application/x-www-form-urlencoded",
        },
      }
    );

    const accessToken = tokenResponse.data.access_token;

    const userInfoResponse = await axios.get(
      "https://www.googleapis.com/oauth2/v2/userinfo",
      {
        headers: {
          Authorization: `Bearer ${accessToken}`,
        },
      }
    );

    const { email } = userInfoResponse.data;

    if (!email) {
      return res.status(400).send("Unable to fetch user email from Google.");
    }

    let user = await User.findOne({ email });

    //updated the below

    if (!user) {
  user = new User({
    userId: uuidv4(),
    email,
    lastLogin: new Date()
  });
} else {
  user.lastLogin = new Date(); // update on each login
}
await user.save();

    const appToken = generateToken(user);

    let redirectBase = process.env.FRONTEND_URL;
    if (typeof state === "string" && state) {
      try {
        const decoded = decodeURIComponent(state);
        if (isAllowedFrontendOrigin(decoded)) {
          redirectBase = decoded;
        }
      } catch {
        // ignore invalid state
      }
    }

    return res.redirect(`${redirectBase}/?token=${appToken}`);
  } catch (error) {
    console.error("Google auth error:", error.response?.data || error.message);
    return res.status(500).send("Authentication failed.");
  }
});

// Album routes

app.post("/albums", authenticateToken, async (req, res) => {
  try {
    const { name, description } = req.body;

    if (!name || typeof name !== "string" || !name.trim()) {
      return res.status(400).json({ error: "Album name is required." });
    }

    const album = new Album({
      albumId: uuidv4(),
      name: name.trim(),
      description: description?.trim() || "",
      ownerId: req.user.userId,
      sharedWith: [],
    });

    await album.save();
    return res.status(201).json(album);
  } catch (error) {
    return res.status(500).json({ error: "Failed to create album." });
  }
});

app.put("/albums/:albumId", authenticateToken, async (req, res) => {
  try {
    const { description } = req.body;

    const album = await getOwnedAlbum(req.params.albumId, req.user);

    if (!album) {
      return res.status(404).json({ error: "Album not found or not authorized." });
    }

    album.description = typeof description === "string" ? description.trim() : "";
    await album.save();

    return res.json(album);
  } catch (error) {
    return res.status(500).json({ error: "Failed to update album." });
  }
});

app.post("/albums/:albumId/share", authenticateToken, async (req, res) => {
  try {
    const { emails } = req.body;

    const album = await getOwnedAlbum(req.params.albumId, req.user);

    if (!album) {
      return res.status(404).json({ error: "Album not found or not authorized." });
    }

    if (!Array.isArray(emails) || emails.length === 0) {
      return res.status(400).json({ error: "Emails array is required." });
    }

    const normalizedEmails = [...new Set(
      emails
        .filter((email) => typeof email === "string")
        .map((email) => email.trim().toLowerCase())
        .filter((email) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email))
    )];

    if (normalizedEmails.length === 0) {
      return res.status(400).json({ error: "No valid emails provided." });
    }

    const users = await User.find({ email: { $in: normalizedEmails } });
    const existingEmails = users.map((user) => user.email);

    const missingEmails = normalizedEmails.filter(
      (email) => !existingEmails.includes(email)
    );

    if (missingEmails.length > 0) {
      return res.status(400).json({
        error: "Some users do not exist in the system.",
        missingEmails,
      });
    }

    const shareableEmails = existingEmails.filter(
      (email) => email !== req.user.email
    );

    album.sharedWith = [...new Set([...album.sharedWith, ...shareableEmails])];
    await album.save();

    return res.json(album);
  } catch (error) {
    return res.status(500).json({ error: "Failed to share album." });
  }
});

app.delete("/albums/:albumId", authenticateToken, async (req, res) => {
  try {
    const album = await getOwnedAlbum(req.params.albumId, req.user);

    if (!album) {
      return res.status(404).json({ error: "Album not found or not authorized." });
    }

    const images = await Image.find({ albumId: album.albumId });

    for (const image of images) {
      if (image.filePath && fs.existsSync(image.filePath)) {
        fs.unlinkSync(image.filePath);
      }
    }

    await Image.deleteMany({ albumId: album.albumId });
    await album.deleteOne();

    return res.json({ message: "Album deleted successfully." });
  } catch (error) {
    return res.status(500).json({ error: "Failed to delete album." });
  }
});

app.get("/albums", authenticateToken, async (req, res) => {
  try {
    const albums = await Album.find({
      $or: [{ ownerId: req.user.userId }, { sharedWith: req.user.email }],
    });

    return res.json(albums);
  } catch (error) {
    return res.status(500).json({ error: "Failed to fetch albums." });
  }
});

// Image routes

app.post(
  "/albums/:albumId/images",
  authenticateToken,
  upload.single("file"),
  async (req, res) => {
    try {
      const album = await getAlbumWithAccess(req.params.albumId, req.user);

      if (!album) {
        return res.status(404).json({ error: "Album not found or not authorized." });
      }

      if (!req.file) {
        return res.status(400).json({ error: "Image file is required." });
      }

      let parsedTags = [];
      if (req.body.tags) {
        try {
          const incomingTags = JSON.parse(req.body.tags);
          if (Array.isArray(incomingTags)) {
            parsedTags = incomingTags
              .map((tag) => String(tag).trim())
              .filter(Boolean);
          }
        } catch (error) {
          return res.status(400).json({ error: "Invalid tags format." });
        }
      }

      const fileSizeBytes  = fs.statSync(req.file.path).size;
      const fileSizeMB = (fileSizeBytes / (1024 * 1024)).toFixed(2);

      const image = new Image({
        imageId: uuidv4(),
        albumId: album.albumId,
        name: req.file.originalname,
        filePath: req.file.path,
        mimeType: req.file.mimetype,
        tags: parsedTags,
        person: req.body.person?.trim() || "",
        isFavorite: req.body.isFavorite === "true",
        comments: [],
        size: fileSizeBytes,
        sizeMB: fileSizeMB,
        uploadedAt: new Date(),
      });

      await image.save();
      return res.status(201).json(image);
    } catch (error) {
      return res.status(500).json({ error: "Failed to upload image." });
    }
  }
);

app.put("/albums/:albumId/images/:imageId/favorite", authenticateToken, async (req, res) => {
  try {
    const album = await getAlbumWithAccess(req.params.albumId, req.user);

    if (!album) {
      return res.status(404).json({ error: "Album not found or not authorized." });
    }

    const image = await Image.findOne({
      imageId: req.params.imageId,
      albumId: req.params.albumId,
    });

    if (!image) {
      return res.status(404).json({ error: "Image not found." });
    }

    image.isFavorite = Boolean(req.body.isFavorite);
    await image.save();

    return res.json(image);
  } catch (error) {
    return res.status(500).json({ error: "Failed to update favorite status." });
  }
});

app.post("/albums/:albumId/images/:imageId/comments", authenticateToken, async (req, res) => {
  try {
    const album = await getAlbumWithAccess(req.params.albumId, req.user);

    if (!album) {
      return res.status(404).json({ error: "Album not found or not authorized." });
    }

    const { comment } = req.body;

    if (!comment || typeof comment !== "string" || !comment.trim()) {
      return res.status(400).json({ error: "Comment is required." });
    }

    const image = await Image.findOne({
      imageId: req.params.imageId,
      albumId: req.params.albumId,
    });

    if (!image) {
      return res.status(404).json({ error: "Image not found." });
    }

    image.comments.push(comment.trim());
    await image.save();

    return res.json(image);
  } catch (error) {
    return res.status(500).json({ error: "Failed to add comment." });
  }
});

app.delete("/albums/:albumId/images/:imageId", authenticateToken, async (req, res) => {
  try {
    const album = await getOwnedAlbum(req.params.albumId, req.user);

    if (!album) {
      return res.status(404).json({ error: "Album not found or not authorized." });
    }

    const image = await Image.findOne({
      imageId: req.params.imageId,
      albumId: req.params.albumId,
    });

    if (!image) {
      return res.status(404).json({ error: "Image not found." });
    }

    if (image.filePath && fs.existsSync(image.filePath)) {
      fs.unlinkSync(image.filePath);
    }

    await image.deleteOne();

    return res.json({ message: "Image deleted successfully." });
  } catch (error) {
    return res.status(500).json({ error: "Failed to delete image." });
  }
});

app.get("/albums/:albumId/images", authenticateToken, async (req, res) => {
  try {
    const album = await getAlbumWithAccess(req.params.albumId, req.user);

    if (!album) {
      return res.status(404).json({ error: "Album not found or not authorized." });
    }

    const { tags } = req.query;

    let query = { albumId: req.params.albumId };

    if (tags) {
      const tagList = String(tags)
        .split(",")
        .map((tag) => tag.trim())
        .filter(Boolean);

      query.tags = { $in: tagList };
    }

    const images = await Image.find(query);
    return res.json(images);
  } catch (error) {
    return res.status(500).json({ error: "Failed to fetch images." });
  }
});

app.get("/albums/:albumId/images/favorites", authenticateToken, async (req, res) => {
  try {
    const album = await getAlbumWithAccess(req.params.albumId, req.user);

    if (!album) {
      return res.status(404).json({ error: "Album not found or not authorized." });
    }

    const images = await Image.find({
      albumId: req.params.albumId,
      isFavorite: true,
    });

    return res.json(images);
  } catch (error) {
    return res.status(500).json({ error: "Failed to fetch favorite images." });
  }
});

//for fetch users
app.get("/kaviosUsers", authenticateToken, async (req, res) => {
  try {
    const users = await User.find(
      { email: { $ne: req.user.email }, lastLogin: { $exists: true } }, // only logged in users
      { _id: 0, email: 1, userId: 1 }
    );
    res.json(users);
  } catch (error) {
    res.status(500).json({ error: "Failed to fetch users." });
  }
});


app.use((error, req, res, next) => {
  if (error instanceof multer.MulterError) {
    if (error.code === "LIMIT_FILE_SIZE") {
      return res.status(400).json({ error: "File size exceeds 5MB limit." });
    }
  }

  if (error.message === "Only image files are allowed.") {
    return res.status(400).json({ error: error.message });
  }

  return res.status(500).json({ error: "Something went wrong." });
});

app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});
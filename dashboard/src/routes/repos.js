// routes/repos.js - GET /api/repos, thin wrapper around registry.js.

const express = require("express");
const { requireAuth } = require("../auth");
const registry = require("../registry");

const router = express.Router();

router.get("/api/repos", requireAuth, (req, res) => {
  try {
    res.json({ repos: registry.listRepos() });
  } catch (err) {
    console.error("routes/repos: failed to read registry:", err.message);
    res.status(500).json({ error: "failed to read registry" });
  }
});

module.exports = router;


const express = require("express");
const path = require("path");

const app = express();
const PORT = process.env.PORT || 3000;

// Serve the website from the public folder
app.use(express.static(path.join(__dirname, "public")));

// Test API endpoint
app.get("/api/hello", (req, res) => {
  res.json({
    message: "Software Approval Tracker is running!"
  });
});

// Start Express
app.listen(PORT, "0.0.0.0", () => {
  console.log(`Server running on port ${PORT}`);
});

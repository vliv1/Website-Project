
const express = require("express");
const app = express();

const PORT = process.env.PORT || 3000;

// Homepage
app.get("/", (req, res) => {
  res.send(`
    <html>
      <head>
        <title>My First Website</title>
      </head>
      <body style="
        font-family: Arial;
        text-align: center;
        padding: 60px;
        background: #f0f4f8;
      ">
        <h1>Welcome to My Website!</h1>
        <p>My Express server is working!</p>
        <button onclick="alert('Hello!')">
          Click Me
        </button>
      </body>
    </html>
  `);
});

// Backend API
app.get("/api/hello", (req, res) => {
  res.json({ message: "Hello from my backend!" });
});

app.listen(PORT, "0.0.0.0", () => {
  console.log(`Server running on port ${PORT}`);
});

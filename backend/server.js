const express = require('express');
const app = express();
const port = 8080; // Choose any available port

app.get('/', (req, res) => {
  res.send('Hello from the backend!');
});

app.listen(port, () => {
  console.log(`Server is running at http://localhost:${port}`);
});


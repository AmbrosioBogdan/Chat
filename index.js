const express = require('express');
const axios = require('axios');
const app = express();
app.use(express.json());

app.post('/mcp', async (req, res) => {
  try {
    const response = await axios.post('https://chat-3ins.onrender.com', req.body);
    res.json(response.data);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Server running on port ${PORT}`));

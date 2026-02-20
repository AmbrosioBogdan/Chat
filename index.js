const express = require('express');
const axios = require('axios');
const app = express();

app.use(express.json());

app.post('/tools/list-services', async (req, res) => {
  try {
    const response = await axios.get('https://api.render.com/v1/services', {
      headers: {
        Authorization: `Bearer ${process.env.RENDER_API_KEY}`
      }
    });

    res.json({
      content: response.data
    });

  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

const PORT = process.env.PORT || 10000;
app.listen(PORT, '0.0.0.0', () => {
  console.log(`Server running on port ${PORT}`);
});

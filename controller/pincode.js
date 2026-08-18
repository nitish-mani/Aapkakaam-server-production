const axios = require("axios");

exports.pincode_controller = async (req, res, next) => {
  const { pincode } = req.body;
  if (!pincode) {
    return res.status(400).json({ error: "Pincode is required" });
  }

  try {
    const response = await axios.get(`https://pincode-data.pages.dev/${pincode}.json`);

    return res.status(200).json({ data: response.data });
  } catch (error) {
    return res.status(404).json({ error: error.message });
  }
};

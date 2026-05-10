import supabase from "../config/supabase.js";
import express from "express";
const router = express.Router();

router.post('/api/contact', async (req, res) => {
  try {
    const { name, email, message } = req.body;

    // Validate required fields
    if (!name || !email || !message) {
      return res.status(400).json({
        error: 'Missing required fields: name, email, and message',
      });
    }

    // Insert into Supabase
    const { data, error } = await supabase
      .from('form')
      .insert([
        {
          name,
          email,
          message,
        },
      ]);

    if (error) {
      console.error('Supabase error:', error);
      return res.status(500).json({ error: 'Failed to submit form' });
    }

    res.status(201).json({
      message: 'Form submitted successfully',
      data,
    });
  } catch (err) {
    console.error('Server error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

export default router;
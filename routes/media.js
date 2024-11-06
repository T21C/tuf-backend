import express from 'express';
import fetch from 'node-fetch';
import { loadPfpList } from '../utils/fileHandlers.js';
import { PATHS } from '../config/constants.js';
import { decodeFromBase32 } from '../utils/encodingHelpers.js';

const router = express.Router();

router.get('/image', async (req, res) => {
    const imageUrl = req.query.url;
  
    try {
      const response = await fetch(imageUrl);
      const contentType = response.headers.get('content-type');
  
      if (!response.ok) {
        return res.status(response.status).send("Failed to fetch image.");
      }
  
      res.set('Content-Type', contentType);
      response.body.pipe(res);
    } catch (error) {
      console.error("Error fetching image:", error);
      res.status(500).send("Error fetching image.");
    }
  });
  
  
  router.get('/bilibili', async (req, res) => {
    const bvid = req.query.bvid;
    const apiUrl = `https://api.bilibili.com/x/web-interface/view?bvid=${bvid}`;
  
    try {
      const response = await fetch(apiUrl);
      const data = await response.json();
  
      if (!response.ok) {
        return res.status(response.status).json(data);
      }
  
      res.json(data);
    } catch (error) {
      console.error("Error fetching data:", error);
      res.status(500).json({ error: "Internal Server Error" });
    }
  });
  
  router.get("/pfp", async (req, res) => {
    const { player } = req.query;
    const pfpList = loadPfpList() 
    res.json(pfpList[player]);
  })


  export default router;
  
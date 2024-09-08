import { Hono } from 'hono';
import { cors } from 'hono/cors'
import { secureHeaders } from 'hono/secure-headers'

var oenv;

const generateToken = async () => {
	try {
	  const response = await fetch('https://accounts.spotify.com/api/token', {
		method: 'POST',
		headers: {
		  'Content-Type': 'application/x-www-form-urlencoded',
		},
		body: new URLSearchParams({
		  grant_type: 'client_credentials',
		  client_id: oenv.SPT_CLIENT_ID, // Assuming SPT_CLIENT_ID is accessible in your environment
		  client_secret: oenv.SPT_CLIENT_SECRET, // Assuming SPT_CLIENT_SECRET is accessible in your environment
		}),
	  });
  
	  const data = await response.json();
	  if (!response.ok) {
		throw new Error(data.error || 'Token generation failed');
	  }
	  return data;
	} catch (error) {
	  throw new Error(`Error generating token: ${error.message}`);
	}
};

// Helper function for delay
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const app = new Hono();

// Middleware to set CORS headers
app.use('*', secureHeaders());
app.use('*', cors());
  
// Handle OPTIONS requests
app.options('*', (c) => {
	return c.text('OK', 200); // Respond to the preflight request
});

// Route: /lyrics/search (with bulk support and delay)
app.get('/lyrics/search', async (c) => {
  oenv = c.env
  const trackName = c.req.query('track');
  const artistName = c.req.query('artist');
  const bulk = c.req.query('bulk') === 'true';
  let userAccessToken = c.req.header('Authorization');
  let socalitoken = '1';

  // Dev mode token generation
  if (c.env.DEV_MODE === 'true') {
    const data = await generateToken();
    userAccessToken = `Bearer ${data.access_token}`;
    socalitoken = data.access_token;
  } else {
    const data2 = await generateToken();
    socalitoken = data2.access_token;
  }

  if (!trackName || !artistName) {
    return c.json({ error: true, details: 'Track or Artist query missing.', status: 403 }, 403);
  }

  const fetchingUrl = `https://api.spotify.com/v1/search?q=track:${trackName} artist:${artistName}&type=track${!bulk ? '&limit=1' : ''}`;
  const resp = await fetch(fetchingUrl, {
    method: 'GET',
    headers: {
      'Content-Type': 'application/json',
      Authorization: userAccessToken || 'none',
    },
  });

  if (resp.status !== 200) {
    return c.json({ error: true, status: resp.status, details: 'Spotify API Error' }, resp.status);
  }

  const data = await resp.json();
  if (data.tracks.total === 0) {
    return c.json({ error: true, details: 'No Tracks Found', status: 404 }, 404);
  }

  if (!bulk) {
    // Single track search
    const trackId = data.tracks.items[0].id;
    const lyricsResp = await fetch(`https://beautiful-lyrics.socalifornian.live/lyrics/${trackId}`, {
      method: 'GET',
      headers: {
        'User-Agent': 'insomnia/9.2.0',
        Origin: 'https://xpui.app.spotify.com',
        Referer: 'https://xpui.app.spotify.com/',
        Authorization: `Bearer ${socalitoken}`,
      },
    });

    if (lyricsResp.status === 404) {
      return c.json({ error: true, details: 'Lyrics Not Found', status: 404 }, 404);
    }

    const lyrics = await lyricsResp.json();
    return c.json({
      error: false,
      name: data.tracks.items[0].name,
      artists: data.tracks.items[0].artists,
      id: trackId,
      ...lyrics,
    });
  } else {
    // Bulk search with 250ms delay
    const tracks = data.tracks.items;
    const fullLyricsList = { error: false, bulk: true, content: [] };

    for (let i = 0; i < tracks.length; i++) {
      const track = tracks[i];
      const lyricsResp = await fetch(`https://beautiful-lyrics.socalifornian.live/lyrics/${track.id}`, {
        method: 'GET',
        headers: {
          'User-Agent': 'insomnia/9.2.0',
          Origin: 'https://xpui.app.spotify.com',
          Referer: 'https://xpui.app.spotify.com/',
          Authorization: `Bearer ${socalitoken}`,
        },
      });
      const lyricsResponse = await lyricsResp.text()
      if (lyricsResp.status === 200) {
        if (lyricsResponse == "") continue;
        const lyrics = JSON.parse(lyricsResponse);
        fullLyricsList.content.push({
          name: track.name,
          artists: track.artists,
          id: track.id,
          ...lyrics,
        });
      }

      // Wait for 250ms before processing the next request
      await delay(250);
    }

    return c.json({
      total: data.tracks.total,
      total_fetched: fullLyricsList.content.length,
      ...fullLyricsList,
    });
  }
});

// Route: /lyrics/id (with multiple IDs support and delay)
app.get('/lyrics/id', async (c) => {
  oenv = c.env
  const trackId = c.req.query('id');
  const ids = c.req.query('ids')?.split(',');
  let userAccessToken = c.req.header('Authorization');
  let socalitoken = '1';

  // Dev mode token generation
  if (c.env.DEV_MODE === 'true') {
    const data = await generateToken();
    userAccessToken = `Bearer ${data.access_token}`;
    socalitoken = data.access_token;
  } else {
    const data2 = await generateToken();
    socalitoken = data2.access_token;
  }

  if (!trackId && !ids) {
    return c.json({ error: true, details: 'Track ID or IDs missing.', status: 403 }, 403);
  }

  const trackIds = trackId ? [trackId] : ids;
  const fullLyricsList = { error: false, bulk: true, content: [] };

  for (let i = 0; i < trackIds.length; i++) {
    const id = trackIds[i];
    const fetchingUrl = `https://api.spotify.com/v1/tracks/${id}`;
    const resp = await fetch(fetchingUrl, {
      method: 'GET',
      headers: {
        'Content-Type': 'application/json',
        Authorization: userAccessToken || 'none',
      },
    });

    if (resp.status !== 200) {
      return c.json({ error: true, status: resp.status, details: 'Spotify API Error' }, resp.status);
    }

    const data = await resp.json();
    const lyricsResp = await fetch(`https://beautiful-lyrics.socalifornian.live/lyrics/${id}`, {
      method: 'GET',
      headers: {
        'User-Agent': 'insomnia/9.2.0',
        Origin: 'https://xpui.app.spotify.com',
        Referer: 'https://xpui.app.spotify.com/',
        Authorization: `Bearer ${socalitoken}`,
      },
    });
    const lyricsResponse = await lyricsResp.text();

    if (lyricsResp.status === 200) {
      if (lyricsResponse == "") return c.json({ error: true, status: 404, details: 'Lyrics Missing' }, 404);
      const lyrics = JSON.parse(lyricsResponse);
      fullLyricsList.content.push({
        name: data.name,
        artists: data.artists,
        id: data.id,
        ...lyrics,
      });
    }

    // Wait for 250ms before processing the next request
    await delay(250);
  }

  if (c.req.query("ids")) {
    return c.json({
      total: trackIds.length,
      total_fetched: fullLyricsList.content.length,
      ...fullLyricsList,
    });
  } else {
    const cont = fullLyricsList.content[0];
    return c.json(cont);
  }
});

// Route: /bin
app.get('/bin', (c) => c.text('bin => bon'));

// Cloudflare Worker script
export default app;

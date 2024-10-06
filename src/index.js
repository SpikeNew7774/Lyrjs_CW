import { Hono } from 'hono';
import { cors } from 'hono/cors';
import { secureHeaders } from 'hono/secure-headers';

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

app.use('*', (c, next) => {
  if (c.req.header("Host") !== c.env.HOSTNAME) {
    if (c.env.DEV_MODE == "true") return next();
    return c.json({ status: 403, error: true, details: "Hostname does not equal to the expected value" }, 403);
  }
  return next();
});

// Handle OPTIONS requests
app.options('*', (c) => {
  return c.text('OK', 200); // Respond to the preflight request
});


// Check for lyrics in the D1 DB by Spotify ID (function outside of fetchMusixmatchLyrics)
const checkLyricsInDB = async (spotifyId, db) => {
  const result = await db.prepare('SELECT lyrics_content FROM lyrics WHERE spotify_id = ?').bind(spotifyId).first();
  if (result && result.lyrics_content) {
    return JSON.parse(result.lyrics_content);
  }
  return null;
};

// Musixmatch lyric fetch helper
const fetchMusixmatchLyrics = async (trackData, c, blData) => {
  const db = oenv.DB; // Assuming the DB binding is passed in the environment
  const { name, artists, album, id } = trackData;
  const artistNames = artists.map(artist => artist.name).join(', ');

  /* // Try to find lyrics in the DB first
  const existingLyrics = await checkLyricsInDB(id, db);
  if (existingLyrics) {
    console.log('Found lyrics in DB, returning...');
    return existingLyrics; // Return the parsed lyrics if found
  } */

  // Helper to get Musixmatch URL
  const getMusixmatchUrl = (token) =>
    `https://cors-proxy.spicetify.app/https://apic-desktop.musixmatch.com/ws/1.1/macro.subtitles.get?format=json&namespace=lyrics_richsynched&subtitle_format=mxm&app_id=web-desktop-app-v1.0&q_album=${album.name}&q_artist=${artistNames}&q_track=${name}&track_spotify_id=spotify:track:${id}&usertoken=${token}`;

  // Fetch the token from the D1 DB
  const getTokenFromDB = async () => {
    const result = await db.prepare('SELECT token FROM tokens WHERE id = ?').bind('musixmatch').first();
    return result?.token || null;
  };

  // Save or update the token in the D1 DB
  const saveTokenToDB = async (token) => {
    await db.prepare('INSERT INTO tokens (id, token) VALUES (?, ?) ON CONFLICT(id) DO UPDATE SET token = excluded.token')
      .bind('musixmatch', token).run();
  };

  // Fetch Musixmatch data helper
  const fetchMusixmatchData = async (token) => {
    const response = await fetch(getMusixmatchUrl(token), {
      method: "GET",
      redirect: "manual",
      headers: {
        "Origin": "https://xpui.app.spotify.com"
      }
    });

    if (response.redirected) {
      console.log('Redirect detected, fetching new token...');
      const newToken = await fetchNewMusixmatchToken();
      await saveTokenToDB(newToken);
      return await fetchMusixmatchData(newToken);
    }

    return await response.json();
  };

  // Fetch new Musixmatch token
  const fetchNewMusixmatchToken = async () => {
    const tokenResponse = await fetch('https://cors-proxy.spicetify.app/https://apic-desktop.musixmatch.com/ws/1.1/token.get?app_id=web-desktop-app-v1.0', {
      method: 'GET',
      headers: {
        'Content-Type': 'application/json',
        'User-Agent': 'insomnia/9.2.0',
        "Origin": "https://xpui.app.spotify.com"
      }
    });
    const tokenData = await tokenResponse.json();
    console.log("TokenData", tokenData);
    return tokenData.message.body.user_token;
  };

  // Main logic
  let mx_token = await getTokenFromDB(); // Check if token exists in the DB
  if (!mx_token) {
    console.log('No Musixmatch token in DB, fetching new token...');
    mx_token = await fetchNewMusixmatchToken();
    await saveTokenToDB(mx_token); // Save new token to the DB
  }

  let musixmatchData = await fetchMusixmatchData(mx_token);

  if (musixmatchData?.message?.header?.status_code === 401) {
    console.log('Token expired, fetching new token...');
    mx_token = await fetchNewMusixmatchToken();
    await saveTokenToDB(mx_token); // Save new token to the DB
    musixmatchData = await fetchMusixmatchData(mx_token);
  }

  const commontrackId = musixmatchData.message.body.macro_calls["matcher.track.get"].message.body.track.commontrack_id;
  const trackDuration = musixmatchData.message.body.macro_calls["matcher.track.get"].message.body.track.track_length;
  const subtitleLength = musixmatchData?.message?.body?.macro_calls["track.subtitles.get"]?.message.body == "" ? null : musixmatchData?.message?.body?.macro_calls["track.subtitles.get"]?.message?.body?.subtitle_list[0]?.subtitle?.subtitle_length;

  const richsyncUrl = `https://cors-proxy.spicetify.app/https://apic-desktop.musixmatch.com/ws/1.1/track.richsync.get?format=json&subtitle_format=mxm&app_id=web-desktop-app-v1.0&commontrack_id=${commontrackId}&usertoken=${mx_token}${subtitleLength != null ? `&f_subtitle_length=${subtitleLength}` : ""}&q_duration=${trackDuration}`;
  const richsyncRes = await fetch(richsyncUrl, {
    headers: {
      "Origin": "https://xpui.app.spotify.com"
    }
  });
  const richsyncData = await richsyncRes.json();

  if (richsyncData?.message?.header?.status_code === 404) {
    if (blData && blData?.Type === "Line") {
      console.log("Using Beautiful-Lyrics data");
      return { blData, from: "bl" };
    }

    if (musixmatchData?.message?.body?.macro_calls["track.subtitles.get"]?.message.body == "" ? true : musixmatchData?.message?.body?.macro_calls["track.subtitles.get"]?.message?.header?.status_code !== 200) {
      console.log("No lyrics found in Musixmatch");
      if (blData && blData?.Type !== "NOTUSE") {
        console.log("Using Beautiful-Lyrics data");
        return { blData, from: "bl" };
      } else {
        return { return_status: 404 };
      }
    }

    const subtitles = JSON.parse(musixmatchData?.message?.body?.macro_calls["track.subtitles.get"]?.message.body == "" ? {"none": true} : musixmatchData?.message?.body?.macro_calls["track.subtitles.get"]?.message?.body?.subtitle_list[0]?.subtitle?.subtitle_body);

    if (subtitles.none !== true) {
      const transformedContent = subtitles.map((item, index, arr) => ({
        Text: item.text,
        StartTime: item.time.total,
        EndTime: index !== arr.length - 1 ? arr[index + 1].time.total : musixmatchData.message.body.macro_calls["matcher.track.get"].message.body.track.track_length,
        Type: "Vocal",
        OppositeAligned: false
      }));

      return {
        Type: "Line",
        alternative_api: true,
        commontrack_id: commontrackId,
        Content: transformedContent
      };
    }
  }

  const richsyncBody = JSON.parse(richsyncData.message.body.richsync.richsync_body);

  const transformedContent = richsyncBody.map(item => {
    let syllables;

    if (c.req.header("Origin") === "https://xpui.app.spotify.com") {
      syllables = item.l
        .filter(lyric => lyric.c.trim() !== "")
        .map(lyric => ({
          Text: lyric.c,
          IsPartOfWord: false,
          StartTime: parseFloat((item.ts + lyric.o).toFixed(3)),
          EndTime: parseFloat((item.ts + lyric.o + (item.te - item.ts) / item.l.length).toFixed(3))
        }));
    } else {
      syllables = item.l.map(lyric => ({
        Text: lyric.c,
        IsPartOfWord: lyric.o !== 0,
        StartTime: parseFloat((item.ts + lyric.o).toFixed(3)),
        EndTime: parseFloat((item.ts + lyric.o + (item.te - item.ts) / item.l.length).toFixed(3))
      }));
    }

    return {
      Type: "Vocal",
      OppositeAligned: false,
      Lead: {
        Syllables: syllables,
        StartTime: item.ts,
        EndTime: item.te
      }
    };
  });

  return {
    Type: "Syllable",
    alternative_api: true,
    commontrack_id: commontrackId,
    Content: transformedContent
  };
};



// Route: /lyrics/id (with multiple IDs support)
app.get('/lyrics/id', async (c) => {
  oenv = c.env;
  const forceMxMatch = c.req.query("forcemx") !== "true";
  const trackId = c.req.query('id');
  const ids = c.req.query('ids')?.split(',');
  let userAccessToken = c.req.header('Authorization');
  let socalitoken = '1';

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

    const dbData = await checkLyricsInDB(data.id, c.env.DB);
    if (dbData != null) {
      if (dbData.Type === "Line") {
        const additData = {
          StartTime: dbData.Content[0].StartTime,
          EndTime: dbData.Content[dbData.Content.length - 1].EndTime,
          ...dbData
        }

        fullLyricsList.content.push({
          name: data.name,
          artists: data.artists,
          id: data.id,
          ...additData
        });
      } else if (dbData.Type === "Syllable") {
        const additData = {
            StartTime: dbData.Content[0].Lead.StartTime,
            EndTime: dbData.Content[dbData.Content.length - 1].Lead.EndTime,
            ...dbData
        }

        fullLyricsList.content.push({
          name: data.name,
          artists: data.artists,
          id: data.id,
          ...additData
        });
      } else if (dbData.Type === "Static") {
        const additData = {
          ...dbData
        }

        fullLyricsList.content.push({
          name: data.name,
          artists: data.artists,
          id: data.id,
          ...additData
        });
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
    }

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
    
    if (lyricsResp.status === 200 && lyricsResponse !== "") {
      const lyrics = JSON.parse(lyricsResponse);
      const type = lyrics.Type || null;

      const blCheck = !forceMxMatch ? false : type === "Syllable";

      if (blCheck) { // Changed my Mind: || type === "Line"
        // If Beautiful-Lyrics has "Syllable", just use it
        fullLyricsList.content.push({
          name: data.name,
          artists: data.artists,
          id: data.id,
          alternative_api: false,
          ...lyrics,
        });
      } else {
        // If not "Syllable", fallback to Musixmatch
        const transformedLyrics = await fetchMusixmatchLyrics(data, c, JSON.parse(lyricsResponse));
        if (transformedLyrics?.return_status === 404) {
          if (c.req.header("Origin") === "https://xpui.app.spotify.com") {
            return c.text("");
          } else {
            return c.json({ error: true, details: 'Lyrics Not Found', status: 404 }, 404);
          }
        }
        if (transformedLyrics.Type === "Line" || transformedLyrics?.blData?.Type === "Line") {
          const additData = !transformedLyrics?.from && transformedLyrics?.from !== "bl" ? {
            StartTime: transformedLyrics.Content[0].StartTime,
            EndTime: transformedLyrics.Content[transformedLyrics.Content.length - 1].EndTime,
            ...transformedLyrics
          } : { ...transformedLyrics.blData, alternative_api: false }

          fullLyricsList.content.push({
            name: data.name,
            artists: data.artists,
            id: data.id,
            ...additData
          });
        } else if (transformedLyrics.Type === "Syllable" || transformedLyrics?.blData?.Type === "Syllable") {
          const additData = !transformedLyrics?.from && transformedLyrics?.from !== "bl" ? {
              StartTime: transformedLyrics.Content[0].Lead.StartTime,
              EndTime: transformedLyrics.Content[transformedLyrics.Content.length - 1].Lead.EndTime,
              ...transformedLyrics
          } : { ...transformedLyrics.blData, alternative_api: false }

          fullLyricsList.content.push({
            name: data.name,
            artists: data.artists,
            id: data.id,
            ...additData
          });
        } else if (transformedLyrics.Type === "Static" || transformedLyrics?.blData?.Type === "Static") {
          const additData = !transformedLyrics?.from && transformedLyrics?.from !== "bl" ? {
            ...transformedLyrics
          } : { ...transformedLyrics.blData, alternative_api: false }

          fullLyricsList.content.push({
            name: data.name,
            artists: data.artists,
            id: data.id,
            ...additData
          });
        }
      }
    } else if (trackIds.length === 1) {
      const transformedLyrics = await fetchMusixmatchLyrics(data, c, { Type: "NOTUSE" });
      if (transformedLyrics?.return_status === 404) {
        if (c.req.header("Origin") === "https://xpui.app.spotify.com") {
          return c.text("");
        } else {
          return c.json({ error: true, details: 'Lyrics Not Found', status: 404 }, 404);
        }
      }

      if (transformedLyrics?.return_status === 404) {
        if (c.req.header("Origin") === "https://xpui.app.spotify.com") {
          return c.text("");
        } else {
          return c.json({ error: true, details: 'Lyrics Not Found', status: 404 }, 404);
        }
      }
      if (transformedLyrics.Type === "Line" || transformedLyrics?.blData?.Type === "Line") {
        const additData = !transformedLyrics?.from && transformedLyrics?.from !== "bl" ? {
          StartTime: transformedLyrics.Content[0].StartTime,
          EndTime: transformedLyrics.Content[transformedLyrics.Content.length - 1].EndTime,
          ...transformedLyrics
        } : { ...transformedLyrics.blData, alternative_api: false }

        fullLyricsList.content.push({
          name: data.name,
          artists: data.artists,
          id: data.id,
          ...additData
        });
      } else if (transformedLyrics.Type === "Syllable" || transformedLyrics?.blData?.Type === "Syllable") {
        const additData = !transformedLyrics?.from && transformedLyrics?.from !== "bl" ? {
            StartTime: transformedLyrics.Content[0].Lead.StartTime,
            EndTime: transformedLyrics.Content[transformedLyrics.Content.length - 1].Lead.EndTime,
            ...transformedLyrics
        } : { ...transformedLyrics.blData, alternative_api: false }

        fullLyricsList.content.push({
          name: data.name,
          artists: data.artists,
          id: data.id,
          ...additData
        });
      } else if (transformedLyrics.Type === "Static" || transformedLyrics?.blData?.Type === "Static") {
        const additData = !transformedLyrics?.from && transformedLyrics?.from !== "bl" ? {
          ...transformedLyrics
        } : { ...transformedLyrics.blData, alternative_api: false }

        fullLyricsList.content.push({
          name: data.name,
          artists: data.artists,
          id: data.id,
          ...additData
        });
      }
    }

    // Wait for 300ms before processing the next request
    await delay(300);
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
  
        // Wait for 300ms before processing the next request, Having an EXPERIMENTAL Option
        await delay(300);
      }
  
      return c.json({
        total: data.tracks.total,
        total_fetched: fullLyricsList.content.length,
        ...fullLyricsList,
      });
    }
  });
  

// Route: /bin
app.get('/bin', (c) => c.text('bin => bon'));

// Cloudflare Worker script
export default app;

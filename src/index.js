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


const rateLimitSkiplist = [
  "https://splay.spikerko.org",
  "https://xpui.app.spotify.com"
];

async function rateLimit(c, next) {
  if (c.req.header("splay-private-token") ? c.req.header("splay-private-token") === c.env.SPLAY_PRIVATE_TOKEN : c.req.header("Origin") && rateLimitSkiplist.includes(c.req.header("Origin"))) {
    return next()
  }

	const ipAddress = c.req.header("cf-connecting-ip") || c.req.header("x-forwarded-for") 
	
  const { success } = await c.env.lyricsRateLimit.limit({ key: ipAddress })
	if (!success) {
		return c.json({ error: true, details: 'You\'ve exceeded the rate limit of 1 request per 10 seconds. Wait atleast 10 seconds before an another request', status: 429 }, 429);
	}
	return next()
}

async function rateSearchLimit(c, next) {
  if (c.req.header("splay-private-token") ? c.req.header("splay-private-token") === c.env.SPLAY_PRIVATE_TOKEN : c.req.header("Origin") && rateLimitSkiplist.includes(c.req.header("Origin"))) {
    return next()
  }

	const ipAddress = c.req.header("cf-connecting-ip") || c.req.header("x-forwarded-for") 
	
  const { success } = await c.env.lyricsSearchRtLimit.limit({ key: ipAddress })
	if (!success) {
		return c.json({ error: true, details: 'You\'ve exceeded the rate limit of 3 requests per 60 seconds. Wait atleast 60 seconds before an another request', status: 429 }, 429);
	}
	return next()
}


/* async function rateLyricsDbReadLimit(c, next) {
	const ipAddress = c.req.header("cf-connecting-ip")
	
  const { success } = await c.env.lyricsDbRead.limit({ key: ipAddress })
	if (!success) {
		return c.json({ error: true, details: 'You\'ve exceeded the rate limit of 1 requests per 60 seconds. Wait atleast 60 seconds before an another request', status: 429 }, 429);
	}
	return next()
} */

// Check for lyrics in the D1 DB by Spotify ID (function outside of fetchMusixmatchLyrics)
const checkLyricsInDB = async (spotifyId, db) => {
  const result = await db.prepare('SELECT lyrics_content FROM lyrics WHERE spotify_id = ?').bind(spotifyId).first();
  if (result && result.lyrics_content) {
    return JSON.parse(result.lyrics_content);
  }
  return null;
};


const checkLyricsFontsInDB = async (spotifyId, db) => {
  const result = await db.prepare('SELECT lyrics_font_data FROM lyrics_fonts WHERE spotify_id = ?').bind(spotifyId).first();
  if (result && result.lyrics_font_data) {
    return JSON.parse(result.lyrics_font_data);
  }
  return null;
};

/* // Check for lyrics in the D1 DB by Spotify ID (function outside of fetchMusixmatchLyrics)
const checkFullLyricsInDB = async (db) => {
  const result = await db.prepare('SELECT spotify_id, lyrics_content FROM lyrics').all();
  if (result && result?.results?.length > 0) {
    // Filter out rows where spotify_id starts with "_"
    const filteredResult = result.results.filter(row => !row.spotify_id.startsWith('_'));

    // Parse the lyrics_content for each row
    return filteredResult;
  }
  return null;
}; */

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
  /* const trackDuration = musixmatchData.message.body.macro_calls["matcher.track.get"].message.body.track.track_length;
  const subtitleLength = musixmatchData?.message?.body?.macro_calls["track.subtitles.get"]?.message.body == "" ? null : musixmatchData?.message?.body?.macro_calls["track.subtitles.get"]?.message?.body?.subtitle_list[0]?.subtitle?.subtitle_length;

  const richsyncUrl = `https://cors-proxy.spicetify.app/https://apic-desktop.musixmatch.com/ws/1.1/track.richsync.get?format=json&subtitle_format=mxm&app_id=web-desktop-app-v1.0&commontrack_id=${commontrackId}&usertoken=${mx_token}${subtitleLength != null ? `&f_subtitle_length=${subtitleLength}` : ""}&q_duration=${trackDuration}`;
  const richsyncRes = await fetch(richsyncUrl, {
    headers: {
      "Origin": "https://xpui.app.spotify.com"
    }
  });
  const richsyncData = await richsyncRes.json();
  console.log(richsyncData?.message?.header?.status_code)
  console.log(richsyncData?.message?.header?.status_code === 404)

  if (richsyncData?.message?.header?.status_code === 404) {
    if (blData && blData?.Type === "Line") {
      console.log("Using Beautiful-Lyrics data");
      return { blData, from: "bl" };
    } */

    if (musixmatchData?.message?.body?.macro_calls["track.subtitles.get"]?.message.body == "" ? true : musixmatchData?.message?.body?.macro_calls["track.subtitles.get"]?.message?.header?.status_code !== 200) {
      console.log("No lyrics found in Musixmatch");
      if (blData && blData?.Type !== "NOTUSE") {
        console.log("Using Beautiful-Lyrics data");
        return { blData, from: "bl" };
      }
    }

    let subtitles;

    try {
      subtitles = musixmatchData?.message?.body?.macro_calls["track.subtitles.get"]?.message.body == "" ? {"none": true} : JSON.parse(musixmatchData?.message?.body?.macro_calls["track.subtitles.get"]?.message?.body?.subtitle_list[0]?.subtitle?.subtitle_body)
    } catch (error) {
      return { return_status: 404 }
    }

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
      const staticLyrics = musixmatchData?.message?.body?.macro_calls["track.lyrics.get"]?.message?.body?.lyrics?.lyrics_body;
      if (staticLyrics) {
        const lines = staticLyrics.split("\n").map(line => ({
          Text: line
        }));

        return {
          Type: "Static",
          Lines: lines,
          alternative_api: true,
          commontrack_id: commontrackId
        };
      }
    return { return_status: 404 }
  /* }

  const richsyncBody = JSON.parse(richsyncData.message.body.richsync.richsync_body);

  const transformedContent = richsyncBody.map(item => {
    let syllables;
/*     console.log("Start Time", parseFloat((item.ts + item.l[0].o).toFixed(3)))
    console.log("End Time", parseFloat((item.ts + item.l[0].o + (item.te - item.ts) / item.l.length).toFixed(3))); 

    if (c.req.header("Origin") === "https://xpui.app.spotify.com") {
      syllables = item.l
        .filter(lyric => lyric.c.trim() !== "")
        .map((lyric, index, arr) => ({
          Text: lyric.c,
          IsPartOfWord: false,
          StartTime: parseFloat((item.ts + lyric.o).toFixed(3)),
          EndTime: parseFloat((item.ts + lyric.o + (item.te - item.ts) / item.l.length).toFixed(3))
        }));
    } else {
      syllables = item.l.map((lyric, index, arr) => ({
        Text: lyric.c,
        IsPartOfWord: false,
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
  }; */
};




// Route: /lyrics/id (with multiple IDs support)
app.get('/lyrics/id', rateLimit, async (c) => {
  oenv = c.env;
  const forceMxMatch = c.req.query("forcemx") !== "true";
  const trackId = c.req.query('id');
  const ids = c.req.query('ids')?.split(',');

  if (trackId && ids) {
    return c.json({ error: true, details: 'You can\'t have a trackId and also ids. Use only one.', status: 400 }, 400);
  }

  if (ids?.length > 100) {
    return c.json({ error: true, details: 'More than 100 tracks can\'t be fetched at one time', status: 400 }, 400);
  }

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
    return c.json({ error: true, details: 'Track ID or IDs missing.', status: 400 }, 400);
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

        const customFonts = await checkLyricsFontsInDB(data.id, c.env.DB)

        const pushContent = customFonts ? {
          name: data.name,
          artists: data.artists,
          id: data.id,
          font: customFonts,
          ...additData
        } : {
          name: data.name,
          artists: data.artists,
          id: data.id,
          ...additData
        }

        fullLyricsList.content.push(pushContent);
      } else if (dbData.Type === "Syllable") {
        const additData = {
            StartTime: dbData.Content[0].Lead.StartTime,
            EndTime: dbData.Content[dbData.Content.length - 1].Lead.EndTime,
            ...dbData
        }

        const customFonts = await checkLyricsFontsInDB(data.id, c.env.DB)

        const pushContent = customFonts ? {
          name: data.name,
          artists: data.artists,
          id: data.id,
          font: customFonts,
          ...additData
        } : {
          name: data.name,
          artists: data.artists,
          id: data.id,
          ...additData
        }

        fullLyricsList.content.push(pushContent);
      } else if (dbData.Type === "Static") {
        const additData = {
          ...dbData
        }

        const customFonts = await checkLyricsFontsInDB(data.id, c.env.DB)

        const pushContent = customFonts ? {
          name: data.name,
          artists: data.artists,
          id: data.id,
          font: customFonts,
          ...additData
        } : {
          name: data.name,
          artists: data.artists,
          id: data.id,
          ...additData
        }

        fullLyricsList.content.push(pushContent);
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

      const blCheck = !forceMxMatch ? false : type === "Syllable" || type === "Line";

      if (blCheck) { // Changed my Mind: || type === "Line"
        // If Beautiful-Lyrics has "Syllable", just use it

        const customFonts = await checkLyricsFontsInDB(data.id, c.env.DB)

        const pushContent = customFonts ? {
          name: data.name,
          artists: data.artists,
          id: data.id,
          alternative_api: false,
          font: customFonts,
          ...lyrics,
        } : {
          name: data.name,
          artists: data.artists,
          id: data.id,
          alternative_api: false,
          ...lyrics,
        }

        fullLyricsList.content.push(pushContent);
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

          const customFonts = await checkLyricsFontsInDB(data.id, c.env.DB)

          const pushContent = customFonts ? {
            name: data.name,
            artists: data.artists,
            id: data.id,
            font: customFonts,
            ...additData
          } : {
            name: data.name,
            artists: data.artists,
            id: data.id,
            ...additData
          }

          fullLyricsList.content.push(pushContent);
        } else if (transformedLyrics.Type === "Syllable" || transformedLyrics?.blData?.Type === "Syllable") {
          const additData = !transformedLyrics?.from && transformedLyrics?.from !== "bl" ? {
              StartTime: transformedLyrics.Content[0].Lead.StartTime,
              EndTime: transformedLyrics.Content[transformedLyrics.Content.length - 1].Lead.EndTime,
              ...transformedLyrics
          } : { ...transformedLyrics.blData, alternative_api: false }

          const customFonts = await checkLyricsFontsInDB(data.id, c.env.DB)

          const pushContent = customFonts ? {
            name: data.name,
            artists: data.artists,
            id: data.id,
            font: customFonts,
            ...additData
          } : {
            name: data.name,
            artists: data.artists,
            id: data.id,
            ...additData
          }

          fullLyricsList.content.push(pushContent);
        } else if (transformedLyrics.Type === "Static" || transformedLyrics?.blData?.Type === "Static") {
          const additData = !transformedLyrics?.from && transformedLyrics?.from !== "bl" ? {
            ...transformedLyrics
          } : { ...transformedLyrics.blData, alternative_api: false }

          const customFonts = await checkLyricsFontsInDB(data.id, c.env.DB)

          const pushContent = customFonts ? {
            name: data.name,
            artists: data.artists,
            id: data.id,
            font: customFonts,
            ...additData
          } : {
            name: data.name,
            artists: data.artists,
            id: data.id,
            ...additData
          }

          fullLyricsList.content.push(pushContent);
        }
      }
    } else {
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

        const customFonts = await checkLyricsFontsInDB(data.id, c.env.DB)

        const pushContent = customFonts ? {
          name: data.name,
          artists: data.artists,
          id: data.id,
          font: customFonts,
          ...additData
        } : {
          name: data.name,
          artists: data.artists,
          id: data.id,
          ...additData
        }

        fullLyricsList.content.push(pushContent);
      } else if (transformedLyrics.Type === "Syllable" || transformedLyrics?.blData?.Type === "Syllable") {
        const additData = !transformedLyrics?.from && transformedLyrics?.from !== "bl" ? {
            StartTime: transformedLyrics.Content[0].Lead.StartTime,
            EndTime: transformedLyrics.Content[transformedLyrics.Content.length - 1].Lead.EndTime,
            ...transformedLyrics
        } : { ...transformedLyrics.blData, alternative_api: false }

        const customFonts = await checkLyricsFontsInDB(data.id, c.env.DB)

        const pushContent = customFonts ? {
          name: data.name,
          artists: data.artists,
          id: data.id,
          font: customFonts,
          ...additData
        } : {
          name: data.name,
          artists: data.artists,
          id: data.id,
          ...additData
        }

        fullLyricsList.content.push(pushContent);
      } else if (transformedLyrics.Type === "Static" || transformedLyrics?.blData?.Type === "Static") {
        const additData = !transformedLyrics?.from && transformedLyrics?.from !== "bl" ? {
          ...transformedLyrics
        } : { ...transformedLyrics.blData, alternative_api: false }

        const customFonts = await checkLyricsFontsInDB(data.id, c.env.DB)

        const pushContent = customFonts ? {
          name: data.name,
          artists: data.artists,
          id: data.id,
          font: customFonts,
          ...additData
        } : {
          name: data.name,
          artists: data.artists,
          id: data.id,
          ...additData
        }

        fullLyricsList.content.push(pushContent);
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
app.get('/lyrics/search', rateSearchLimit, async (c) => {
  oenv = c.env;
  const trackName = c.req.query('track');
  const artistName = c.req.query('artist');

  const bulk = c.req.query('bulk') === 'true';
  let userAccessToken = c.req.header('Authorization');
  let socalitoken = '1';
  const forceMxMatch = c.req.query("forcemx") !== "true";

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
    return c.json({ error: true, details: 'Track or Artist query missing.', status: 400 }, 400);
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

  const processLyrics = async (track) => {
      const trackId = track.id;
      let lyrics = null;

      // Check lyrics in DB
      const dbData = await checkLyricsInDB(trackId, c.env.DB);
      if (dbData != null) {
          if (dbData.Type === "Line") {
              const additData = {
                  StartTime: dbData.Content[0].StartTime,
                  EndTime: dbData.Content[dbData.Content.length - 1].EndTime,
                  ...dbData
              };
              lyrics = additData;
          } else if (dbData.Type === "Syllable") {
              const additData = {
                  StartTime: dbData.Content[0].Lead.StartTime,
                  EndTime: dbData.Content[dbData.Content.length - 1].Lead.EndTime,
                  ...dbData
              };
              lyrics = additData;
          } else if (dbData.Type === "Static") {
              lyrics = dbData;
          }
      }

      if (!lyrics) {
          // Fetch lyrics from Beautiful Lyrics API
          const lyricsResp = await fetch(`https://beautiful-lyrics.socalifornian.live/lyrics/${trackId}`, {
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
              const fetchedLyrics = JSON.parse(lyricsResponse);
              const type = fetchedLyrics.Type || null;

              if (!forceMxMatch || type === "Syllable" || type === "Line") {
                  lyrics = fetchedLyrics;
              } else {
                  // If not "Syllable", fallback to Musixmatch
                  const transformedLyrics = await fetchMusixmatchLyrics(track, c, fetchedLyrics);
                  if (transformedLyrics.return_status !== 404) {
                      lyrics = transformedLyrics;
                  }
              }
          }
      }

      if (!lyrics) return null

      const customFonts = await checkLyricsFontsInDB(data.id, c.env.DB)

      const returnContent = customFonts ? { 
        name: track.name, 
        artists: track.artists, 
        id: track.id,
        font: customFonts,
        ...lyrics 
      } : { 
        name: track.name, 
        artists: track.artists, 
        id: track.id, 
        ...lyrics 
      } 

      return returnContent
  };

  if (!bulk) {
    // Single track search
    const track = data.tracks.items[0];
    const processedLyrics = await processLyrics(track);

    if (!processedLyrics) {
      return c.json({ error: true, details: 'Lyrics Not Found', status: 404 }, 404);
    }

    return c.json(processedLyrics);
  } else {
    // Bulk search with 20-track limit and 300ms delay
    const tracks = data.tracks.items;
    const fullLyricsList = { error: false, bulk: true, content: [] };
    
    // Process only the first 20 tracks, even if more are found
    const limitedTracks = tracks.slice(0, 20);

    for (let i = 0; i < limitedTracks.length; i++) {
      const track = limitedTracks[i];
      const processedLyrics = await processLyrics(track);
      if (processedLyrics) {
        fullLyricsList.content.push(processedLyrics);
      }

      // Wait for 300ms before processing the next request
      await delay(300);
    }

    return c.json({
      total: Math.min(data.tracks.total, 20),
      total_fetched: fullLyricsList.content.length,
      ...fullLyricsList,
    });
  }
});

  
app.get('/', (c) => {
  return c.redirect("https://github.com/SpikeNew7774/Lyrjs_CW")
})

/* app.get("/open-source/lyricsdb", rateLyricsDbReadLimit, async (c) => {
  const dbContent = await checkFullLyricsInDB(c.env.DB)
  return c.json(dbContent)
}) */


// Route: /bin
app.get('/bin', (c) => c.text('bin => bon'));

// Cloudflare Worker script
export default app;

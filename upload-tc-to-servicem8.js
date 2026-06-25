// netlify/functions/upload-tc-to-servicem8.js
//
// PURPOSE
// Receives a signed T&C PDF (already generated client-side, same pattern as the
// diagnostics report) plus the job number it belongs to, and uploads it into the
// correct ServiceM8 job's diary via the official 3-step Attachment API.
//
// WHY THE PDF IS GENERATED CLIENT-SIDE, NOT HERE
// Netlify Functions run in a constrained serverless environment without a full
// filesystem or headless-browser support. Libraries like Puppeteer (which need a
// real Chromium binary) are unreliable here. Since the diagnostics form already
// generates PDFs successfully in the browser with jsPDF, this function follows the
// same pattern: the browser builds the PDF, this function just relays it to ServiceM8.
//
// REQUIRED ENVIRONMENT VARIABLE (set in Netlify dashboard, never in this file):
//   SERVICEM8_API_KEY = your private application API key
//
// EXPECTED REQUEST BODY (JSON):
// {
//   "jobNumber": "1450",          // from {job.generated_job_id} in the SMS/email link
//   "customerName": "Jane Smith", // typed name acting as signature
//   "agreedDate": "25 June 2026",
//   "agreedAt": "2026-06-25T05:58:19.323Z",
//   "pdfBase64": "JVBERi0xLjQK..." // the signed T&C PDF, base64-encoded, no data: prefix
// }

const SERVICEM8_BASE = 'https://api.servicem8.com/api_1.0';

exports.handler = async function (event) {
  // CORS preflight support, in case the form ever calls this from a different origin
  if (event.httpMethod === 'OPTIONS') {
    return {
      statusCode: 204,
      headers: corsHeaders(),
      body: '',
    };
  }

  if (event.httpMethod !== 'POST') {
    return jsonResponse(405, { error: 'Method not allowed. Use POST.' });
  }

  const apiKey = process.env.SERVICEM8_API_KEY;
  if (!apiKey) {
    console.error('SERVICEM8_API_KEY is not set in the environment.');
    return jsonResponse(500, { error: 'Server is not configured correctly. Please call S.A.F.E.R directly on 0474 810 874.' });
  }

  let payload;
  try {
    payload = JSON.parse(event.body);
  } catch (err) {
    return jsonResponse(400, { error: 'Invalid JSON in request body.' });
  }

  const { jobNumber, customerName, agreedDate, agreedAt, pdfBase64 } = payload;

  if (!jobNumber) {
    return jsonResponse(400, { error: 'Missing jobNumber. The booking link is missing its job reference.' });
  }
  if (!customerName || !pdfBase64) {
    return jsonResponse(400, { error: 'Missing required fields (customerName or pdfBase64).' });
  }

  try {
    // STEP 1: Look up the job's UUID from its human-readable job number.
    // We never create a job here — it must already exist in ServiceM8.
    const jobUuid = await findJobUuidByNumber(jobNumber, apiKey);
    if (!jobUuid) {
      return jsonResponse(404, {
        error: `No job found with number ${jobNumber}. Please call S.A.F.E.R on 0474 810 874 so we can confirm your booking manually.`,
      });
    }

    // STEP 2: Create the attachment record, scoped to that job.
    const attachmentName = `SAFER Terms & Conditions - Signed - Job ${jobNumber}.pdf`;
    const attachmentUuid = await createAttachmentRecord(jobUuid, attachmentName, apiKey);

    // STEP 3: Submit the actual PDF binary data to that attachment record.
    await submitAttachmentFile(attachmentUuid, pdfBase64, attachmentName, apiKey);

    // STEP 4 (best-effort, non-blocking): add a plain-text note to the job diary too,
    // so it's easy for a tech to spot at a glance, even before opening the attachment.
    // If this fails, we don't fail the whole request — the signed PDF is already safely attached.
    try {
      await addJobNote(
        jobUuid,
        `T&C's confirmed online by ${customerName} on ${agreedDate} (${agreedAt}). Signed copy attached to this job's diary.`,
        apiKey
      );
    } catch (noteErr) {
      console.warn('Attachment succeeded but adding the diary note failed:', noteErr.message);
    }

    return jsonResponse(200, { success: true, jobNumber, attachmentUuid });
  } catch (err) {
    console.error('ServiceM8 upload failed:', err);
    return jsonResponse(502, {
      error: 'We could not save your confirmation to our system. Please call S.A.F.E.R on 0474 810 874 so we can confirm manually — nothing has been lost.',
    });
  }
};

// ---------- ServiceM8 API helpers ----------

async function findJobUuidByNumber(jobNumber, apiKey) {
  // generated_job_id is the field shown to users as "Job Number" in ServiceM8's UI
  // and in SMS/email templates via the {job.generated_job_id} merge field.
  const filter = encodeURIComponent(`generated_job_id eq '${jobNumber}'`);
  const url = `${SERVICEM8_BASE}/job.json?$filter=${filter}`;

  const res = await fetch(url, {
    method: 'GET',
    headers: {
      'X-API-Key': apiKey,
      Accept: 'application/json',
    },
  });

  if (!res.ok) {
    throw new Error(`Job lookup failed with status ${res.status}`);
  }

  const jobs = await res.json();
  if (!Array.isArray(jobs) || jobs.length === 0) {
    return null;
  }
  return jobs[0].uuid;
}

async function createAttachmentRecord(jobUuid, attachmentName, apiKey) {
  const res = await fetch(`${SERVICEM8_BASE}/Attachment.json`, {
    method: 'POST',
    headers: {
      'X-API-Key': apiKey,
      'Content-Type': 'application/json',
      Accept: 'application/json',
    },
    body: JSON.stringify({
      related_object: 'job',
      related_object_uuid: jobUuid,
      attachment_name: attachmentName,
      file_type: '.pdf',
      active: true,
    }),
  });

  if (!res.ok) {
    throw new Error(`Creating attachment record failed with status ${res.status}`);
  }

  const attachmentUuid = res.headers.get('x-record-uuid');
  if (!attachmentUuid) {
    throw new Error('ServiceM8 did not return an attachment UUID.');
  }
  return attachmentUuid;
}

async function submitAttachmentFile(attachmentUuid, pdfBase64, attachmentName, apiKey) {
  // IMPORTANT: ServiceM8 expects the raw file as multipart/form-data here, not JSON/base64.
  // Sending base64-in-JSON to this endpoint is a known cause of attachments showing up
  // blank in the job diary (a mistake several other ServiceM8 API integrations have hit).
  const fileBuffer = Buffer.from(pdfBase64, 'base64');

  const form = new FormData();
  form.append('file', new Blob([fileBuffer], { type: 'application/pdf' }), attachmentName);

  const res = await fetch(`${SERVICEM8_BASE}/Attachment/${attachmentUuid}.file`, {
    method: 'POST',
    headers: {
      'X-API-Key': apiKey,
      Accept: 'application/json',
      // Do NOT set Content-Type manually here — fetch sets the correct
      // multipart boundary automatically when given a FormData body.
    },
    body: form,
  });

  if (!res.ok) {
    throw new Error(`Submitting attachment file failed with status ${res.status}`);
  }
}

async function addJobNote(jobUuid, noteText, apiKey) {
  const res = await fetch(`${SERVICEM8_BASE}/note.json`, {
    method: 'POST',
    headers: {
      'X-API-Key': apiKey,
      'Content-Type': 'application/json',
      Accept: 'application/json',
    },
    body: JSON.stringify({
      related_object: 'job',
      related_object_uuid: jobUuid,
      note: noteText,
      active: true,
    }),
  });

  if (!res.ok) {
    throw new Error(`Adding job note failed with status ${res.status}`);
  }
}

// ---------- Small response helpers ----------

function corsHeaders() {
  return {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
  };
}

function jsonResponse(statusCode, bodyObj) {
  return {
    statusCode,
    headers: { 'Content-Type': 'application/json', ...corsHeaders() },
    body: JSON.stringify(bodyObj),
  };
}

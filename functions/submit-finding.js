const dedent = require("dedent");
const { Octokit } = require("@octokit/core");
const { token, apiKey, domain } = require("./_config");
const csv = require("csvtojson");

const octokit = new Octokit({ auth: token });
const mg = require("mailgun-js")({ apiKey, domain });

function isDangerousHandle(s) {
  return s.match(/^[0-9a-zA-Z_\-]+$/) === null;
}

function isDangerousRepo(s) {
  return s.match(/^[0-9a-zA-Z\-]+$/) === null;
}

async function getContestEnd(contestId) {
  const contests = await csv().fromFile("_data/contests/contests.csv");

  const contest = contests.find((c) => c.contestid == contestId);
  return new Date(contest.end_time).getTime();
}

exports.handler = async (event) => {
  // only allow POST
  if (event.httpMethod !== "POST") {
    return {
      statusCode: 405,
      body: JSON.stringify({ error: "Method not allowed" }),
      headers: { Allow: "POST" },
    };
  }

  const data = JSON.parse(event.body);
  const {
    email,
    address,
    handle,
    risk,
    title,
    body,
    labels,
    contest,
    sponsor,
    repo,
  } = data;

  const owner = "code-423n4";

  // ensure we have the data we need
  if (
    !email ||
    !handle ||
    !address ||
    !risk ||
    !title ||
    !body ||
    !labels ||
    !contest ||
    !sponsor ||
    !repo
  ) {
    return {
      statusCode: 422,
      body: JSON.stringify({
        error:
          "Email, handle, address, risk, title, body, and labels are required.",
      }),
    };
  }

  if (isDangerousRepo(repo)) {
    return {
      statusCode: 400,
      body: JSON.stringify({
        error:
          "Repository can only contain alphanumeric characters [a-zA-Z0-9] and hyphens (-).",
      }),
    };
  }

  if (isDangerousHandle(handle)) {
    return {
      statusCode: 400,
      body: JSON.stringify({
        error:
          "Handle can only contain alphanumeric characters [a-zA-Z0-9], underscores (_), and hyphens (-).",
      }),
    };
  }

  // make sure finding was submitted within the contest window, allowing 5 sec padding
  try {
    const contestEnd = await getContestEnd(contest);
    if (Date.now() - 5000 > contestEnd) {
      return {
        statusCode: 400,
        body: JSON.stringify({ error: "This contest has ended." }),
      };
    }
  } catch (error) {
    console.error(error);
    return {
      statusCode: 422,
      body: JSON.stringify({ error: "Error fetching contest data" }),
    };
  }

  const recipients = `${email}, submissions@code423n4.com`;
  const text = dedent`
  C4 finding submitted: (risk = ${labels[1]})
  
  ${body}
  `;

  const emailData = {
    from: "submissions@code423n4.com",
    to: recipients,
    subject: `C4 ${sponsor} finding: ${title}`,
    text,
  };

  try {
    const markdownPath = `data/${handle}-${risk}-${Date.now()}.md`;
    const qaOrGasSubmissionBody = `This report was too long to be submitted as a GitHub issue. [See the markdown file here](https://github.com/${owner}/${repo}/blob/main/${markdownPath}).`;
    const isQaOrGasSubmission = Boolean(risk === "G" || risk === "1");

    const issueResult = await octokit.request(
      "POST /repos/{owner}/{repo}/issues",
      {
        owner,
        repo,
        title,
        body: isQaOrGasSubmission ? qaOrGasSubmissionBody : body,
        labels,
      }
    );

    const issueId = issueResult.data.number;
    const issueUrl = issueResult.data.html_url;
    const message = `${handle} issue #${issueId}`;
    const path = `data/${handle}-${issueId}.json`;
    const fileData = {
      contest,
      handle,
      address,
      risk,
      title,
      issueId,
      issueUrl,
    };

    const content = Buffer.from(JSON.stringify(fileData, null, 2)).toString(
      "base64"
    );

    await octokit.request("PUT /repos/{owner}/{repo}/contents/{path}", {
      owner,
      repo,
      path,
      message,
      content,
    });

    if (isQaOrGasSubmission) {
      await octokit.request("PUT /repos/{owner}/{repo}/contents/{path}", {
        owner,
        repo,
        path: markdownPath,
        message: `${handle} data for issue #${issueId}`,
        content: Buffer.from(body).toString("base64"),
      });
    }
  } catch (error) {
    return {
      statusCode: error.response.status,
      body: JSON.stringify({
        error: error.response.data.message.toString(),
      }),
    };
  }

  try {
    // Special email used for testing
    if (email === "@@@") {
      return {
        statusCode: 200,
        body: JSON.stringify({
          error: "Issue posted successfully and confirmation email sent.",
        }),
      };
    }

    return mg
      .messages()
      .send(emailData)
      .then(() => ({
        statusCode: 200,
        body: JSON.stringify({
          error: "Issue posted successfully and confirmation email sent.",
        }),
      }))
      .catch((error) => ({
        statusCode: 500,
        body: `Error: ${error}`,
      }));
  } catch (error) {
    return {
      statusCode: 500,
      body: JSON.stringify({
        error: "Something went wrong with your submission. Please try again.",
      }),
    };
  }
};

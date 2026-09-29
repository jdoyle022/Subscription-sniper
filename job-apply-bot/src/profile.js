const fs = require("fs");
const path = require("path");

const ROOT = path.join(__dirname, "..");

async function readResumeText(file) {
  const ext = path.extname(file).toLowerCase();
  if (ext === ".pdf") {
    const pdf = require("pdf-parse");
    return (await pdf(fs.readFileSync(file))).text;
  }
  if (ext === ".docx") {
    const mammoth = require("mammoth");
    return (await mammoth.extractRawText({ path: file })).value;
  }
  return fs.readFileSync(file, "utf8");
}

async function loadProfile(profilePath) {
  const abs = path.resolve(ROOT, profilePath);
  if (!fs.existsSync(abs)) {
    throw new Error(`No profile at ${abs}. Copy profile/profile.example.json to profile/profile.json and fill it in.`);
  }
  const profile = JSON.parse(fs.readFileSync(abs, "utf8"));
  const resumeFile = path.resolve(path.dirname(abs), profile.resumeFile || "resume.pdf");
  if (!fs.existsSync(resumeFile)) throw new Error(`Resume not found at ${resumeFile} (set "resumeFile" in your profile).`);
  const resumeText = (await readResumeText(resumeFile)).trim();
  if (!resumeText) throw new Error(`Couldn't extract any text from ${resumeFile}. If it's a scanned PDF, export a text-based PDF, .docx, or .txt instead.`);
  const coverLetterFile = profile.coverLetterFile ? path.resolve(path.dirname(abs), profile.coverLetterFile) : null;
  return { profile, resumeText, resumeFile, coverLetterFile };
}

module.exports = { loadProfile, ROOT };

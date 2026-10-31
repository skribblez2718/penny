import { canonicalJson } from "../canonical-json.js";
import type { ArtifactRef } from "../contracts.js";
import { reviewPlaybackCoverage } from "./human-review-coverage.js";
import { candidateDigest, type HumanReviewCandidateV1 } from "./human-review.js";

export function reviewHtmlEscape(value: string): string {
  return value.replace(
    /[&<>"']/gu,
    (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c] ?? ""
  );
}
export const REVIEW_CSS = `
:root{color-scheme:light dark;font:100%/1.6 system-ui,sans-serif;background:#fff;color:#17202a}
*{box-sizing:border-box}body{margin:0}main,header{max-width:64rem;margin:auto;padding:1rem}
a{color:#164c9c}a:focus-visible,button:focus-visible,input:focus-visible,select:focus-visible,textarea:focus-visible,video:focus-visible{outline:3px solid #164c9c;outline-offset:3px}
.skip{position:absolute;top:-6rem;left:1rem}.skip:focus{top:0;background:#fff;padding:.5rem;z-index:2}
video{display:block;width:100%;max-height:70vh;background:#000}code,dd,textarea{overflow-wrap:anywhere}dd{margin-left:0}dt{font-weight:700;margin-top:.5rem}
fieldset{border:1px solid #667085;margin:1rem 0;padding:1rem}label{display:block;margin:.6rem 0}input,select,textarea,button{font:inherit;min-height:44px;max-width:100%;padding:.4rem;border:1px solid #667085;background:#fff;color:#17202a}input,textarea{width:100%}textarea{min-height:7rem}button{cursor:pointer;border:2px solid #164c9c}#status{padding:.6rem;border-left:4px solid #164c9c}
@media(prefers-color-scheme:dark){:root{background:#101820;color:#f5f7fa}a{color:#9dcbff}input,select,textarea,button,.skip:focus{background:#101820;color:#f5f7fa}a:focus-visible,button:focus-visible,input:focus-visible,select:focus-visible,textarea:focus-visible,video:focus-visible{outline-color:#9dcbff}button,#status{border-color:#9dcbff}}
@media(prefers-reduced-motion:reduce){*{scroll-behavior:auto}}
`;
/** Static browser program, no untrusted code interpolation, network writes or persistent storage.
 * The event counters are explicitly untrusted diagnostics, NEVER a watch/human/approval proof. */
export const REVIEW_JS = `"use strict";
const video=document.querySelector("video"), form=document.querySelector("form"), status=document.getElementById("status");
const coverage=${reviewPlaybackCoverage.toString()};
let seeks=0, overflow=false;
const samples=[], started=performance.now();
function sample(){
 if(samples.length>=65536){overflow=true;return;}
 const media_ms=Math.floor(video.currentTime*1000), clock_ms=Math.floor(performance.now()-started);
 if(!Number.isSafeInteger(media_ms)||!Number.isSafeInteger(clock_ms))return;
 samples.push({media_ms,clock_ms,eligible:!video.paused&&!video.muted&&video.volume>0&&!document.hidden&&video.playbackRate===1&&video.readyState>=3,seeking:video.seeking});
}
for(const name of ["timeupdate","playing","pause","seeking","seeked","volumechange","ratechange","waiting","ended"])video.addEventListener(name,sample);
document.addEventListener("visibilitychange",sample);
video.addEventListener("seeking",()=>{seeks++;});
video.addEventListener("error",()=>{status.textContent="Playback failed. Do not attest complete viewing. Report this in the trusted questionnaire.";});
video.addEventListener("ended",()=>{status.textContent="Playback ended. This does not prove anyone watched. Answer every review question yourself.";});
document.getElementById("diagnostics").addEventListener("click",()=>{
 try{
 const report=coverage(samples,Number(form.dataset.duration));
 status.textContent="Eligible browser-reported coverage: "+(report.covered_ms/1000).toFixed(1)+" seconds; seeks: "+seeks+"; excluded intervals: "+report.excluded_intervals+(overflow?"; sample limit reached":"")+". Seeking, muted, hidden, paused, non-normal-speed and inconsistent intervals are excluded. Unattended playback is not detectable. This is not authenticated watch proof.";
 }catch{status.textContent="Playback diagnostics unavailable. No watch proof or approval was produced.";}
});
form.addEventListener("submit",event=>{
 event.preventDefault();if(!form.reportValidity())return;
 const data=new FormData(form), result={schema_id:"penny.videogen-human-review-answers.v1",schema_version:1,candidate_digest:form.dataset.candidate};
 for(const key of ["reviewer_id","reviewer_role","issues","image","audio","captions","overall","motion","speech","sync","identity"])result[key]=data.get(key);
 for(const key of ["complete_viewing","heard_audio"])result[key]=data.get(key)==="yes";
 result.playback_device_profile_ref=JSON.parse(document.getElementById("device").textContent);
 const output=document.getElementById("response");output.value=JSON.stringify(result,null,2);output.focus();
 status.textContent="Local draft only. Nothing was submitted or approved. Copy the response into the trusted interactive questionnaire, after your actual review. A model must not answer for you.";
});
`;
export function humanReviewPage(candidate: HumanReviewCandidateV1, device: ArtifactRef): string {
  const esc = reviewHtmlEscape;
  const refLabel = (name: string, ref: ArtifactRef) =>
    `<dt>${esc(name)}</dt><dd>Revision ${ref.version} · <code>${esc(ref.artifact_id)}</code><br>SHA-256 <code>${ref.content_digest}</code></dd>`;
  const choice = (name: string, label: string, boolean = false) =>
    `<label for="${name}">${label}</label><select required id="${name}" name="${name}"><option value="">Choose an answer</option>${(boolean
      ? [
          ["yes", "Yes"],
          ["no", "No / not completed"],
        ]
      : [
          ["pass", "Pass"],
          ["fail", "Fail"],
          ["uncertain", "Uncertain / not assessed"],
        ]
    )
      .map(([v, l]) => `<option value="${v}">${l}</option>`)
      .join("")}</select>`;
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Final candidate review</title><link rel="stylesheet" href="style.css"><script src="viewer.js" defer></script></head><body>
<a class="skip" href="#review">Skip to review</a><header><h1>Review the final candidate</h1><p>Private, read-only playback. No approval can be submitted here.</p></header><main id="review">
<h2>Watch and listen</h2><p>Play the entire film with sound. Use the video controls to pause, seek, adjust volume or enter full screen. Captions in this exact master remain unchanged. If playback fails or any part was not assessed, report it rather than approving.</p>
<video controls playsinline preload="metadata" disableremoteplayback disablepictureinpicture controlslist="noremoteplayback" aria-label="Exact final candidate with audio and original captions" aria-describedby="transcript-help"><source src="master.mp4" type="video/mp4">HTML5 video is required. Report unsupported playback in the trusted questionnaire.</video>
<p id="status" role="status">Playback has not been attested. The browser cannot prove a human watched.</p><button type="button" id="diagnostics">Show playback diagnostics (not proof)</button>
<h2>Candidate identity</h2><dl><dt>Package</dt><dd>${esc(candidate.package_id)}</dd>${refLabel("Master", candidate.master_ref)}${refLabel("Package manifest", candidate.manifest_ref)}${refLabel("Native project", candidate.native_project_ref)}<dt>Review binding</dt><dd><code>${candidateDigest(candidate)}</code></dd></dl>
<h2>Caption transcript</h2><p id="transcript-help">Read-only text from the package edit. This transcript does not replace the captions visible in the master, or certify their timing or accuracy.</p><ol>${candidate.captions.map((c) => `<li>${c.start_ms / 1000}–${c.end_ms / 1000} seconds: ${esc(c.text)}</li>`).join("")}</ol>${candidate.captions.length ? "" : "<p>No caption items were supplied in this package edit. Mark captions uncertain or fail if captions are required.</p>"}
<h2>Your review</h2><p>These controls prepare a local response only. Your identity and role are self-declared, not authenticated watch proof. Submit the draft yourself through the trusted interactive questionnaire. Never ask a model to attest for you. This viewer expires; ask the operator to reopen it if needed. Your draft is not saved.</p>
<form data-candidate="${candidateDigest(candidate)}" data-duration="${candidate.duration_ms}"><fieldset><legend>Reviewer</legend><label for="reviewer_id">Identity (letters, digits, dots, underscores, colons or hyphens)</label><input id="reviewer_id" name="reviewer_id" required maxlength="128" pattern="[A-Za-z0-9][A-Za-z0-9._:-]*" autocomplete="off"><label for="reviewer_role">Role</label><input id="reviewer_role" name="reviewer_role" required maxlength="256" autocomplete="off"></fieldset>
<fieldset><legend>Explicit playback attestation</legend>${choice("complete_viewing", "Did you personally watch the entire film?", true)}${choice("heard_audio", "Did you personally hear all of the audio?", true)}</fieldset>
<fieldset><legend>Assess every category</legend>${[
    ["image", "Image quality"],
    ["audio", "Audio quality"],
    ["captions", "Caption accuracy, visibility and timing"],
    ["overall", "Overall suitability"],
    ["motion", "Motion and continuity"],
    ["speech", "Speech intelligibility"],
    ["sync", "Audio/video synchronization"],
    ["identity", "Speaker and visual identity consistency"],
  ]
    .map(([n, l]) => choice(n ?? "", l ?? ""))
    .join("")}</fieldset>
<label for="issues">Issues and limitations (include times; write “none” if none)</label><textarea id="issues" name="issues" required maxlength="8192"></textarea><details><summary>Playback device profile — exact reference</summary><code id="device">${esc(canonicalJson(device))}</code></details><button type="submit">Prepare response — not approval</button></form>
<label for="response">Local response to copy into the trusted questionnaire</label><textarea id="response" readonly spellcheck="false"></textarea><noscript><p>JavaScript is disabled. Playback still works. Answer all review categories directly in the trusted questionnaire.</p></noscript></main></body></html>`;
}

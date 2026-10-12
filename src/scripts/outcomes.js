function manualRequired(service) {
  return { success: false, manual: true, outcome: 'manual_required',
    message: `${service} requires manual cancellation. Its automation has not been validated.` };
}

function needsReview() {
  return { success: false, needsReview: true, outcome: 'needs_review',
    message: 'Cancellation outcome is uncertain. Check the selected subscription before trying again.' };
}

function failedBeforeSubmission() {
  return { success: false, outcome: 'failed_before_submission',
    message: 'Cancellation did not reach submission. Check login, billing source, and the selected subscription.' };
}

module.exports = { manualRequired, needsReview, failedBeforeSubmission };

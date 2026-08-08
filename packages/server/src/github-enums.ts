import {GitHubCheckState, GitHubReviewState} from '@agent-storm/common';

/**
 * GitHub's `StatusState` vocabulary, shared by the rollup verdict and by `StatusContext` entries.
 * Anything missing here (including `EXPECTED` variants GitHub adds later) degrades to
 * {@link GitHubCheckState.None} rather than throwing.
 */
export const checkStatesByGraphqlValue: Readonly<Record<string, GitHubCheckState>> = {
    SUCCESS: GitHubCheckState.Success,
    FAILURE: GitHubCheckState.Failure,
    ERROR: GitHubCheckState.Failure,
    PENDING: GitHubCheckState.Pending,
    EXPECTED: GitHubCheckState.Pending,
};

/** GitHub's `PullRequestReviewState`, used for one reviewer's latest verdict. */
export const reviewStatesByGraphqlValue: Readonly<Record<string, GitHubReviewState>> = {
    APPROVED: GitHubReviewState.Approved,
    CHANGES_REQUESTED: GitHubReviewState.ChangesRequested,
    COMMENTED: GitHubReviewState.Commented,
    DISMISSED: GitHubReviewState.Dismissed,
    PENDING: GitHubReviewState.Pending,
};

/**
 * GitHub's `PullRequestReviewDecision` is a different, smaller enum than a single reviewer's state:
 * it is `APPROVED`, `CHANGES_REQUESTED`, `REVIEW_REQUIRED`, or null when the repo requires no
 * review. `REVIEW_REQUIRED` is the aggregate equivalent of "waiting on someone", which is what
 * {@link GitHubReviewState.Pending} means here.
 */
export const reviewDecisionsByGraphqlValue: Readonly<Record<string, GitHubReviewState>> = {
    APPROVED: GitHubReviewState.Approved,
    CHANGES_REQUESTED: GitHubReviewState.ChangesRequested,
    REVIEW_REQUIRED: GitHubReviewState.Pending,
};

import { ASK_USER_QUESTION_LIMITS } from '../../shared/types/permissions';

// Every prompt that tells the model to ask carries this: told only "use AskUserQuestion", a model asks once and guesses the rest.
export const ASK_AS_OFTEN_AS_NEEDED: string = `There is no limit on AskUserQuestion calls: each call holds up to ${ASK_USER_QUESTION_LIMITS.MAX_QUESTIONS} questions, so call it again whenever you have more, or when a question depends on an earlier answer, rather than guessing.`;

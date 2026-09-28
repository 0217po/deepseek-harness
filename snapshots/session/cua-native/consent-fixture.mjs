/** Scripted human consent for the native application replay. */
export const name = 'cua-consent-fixture'
export const inject = ['userQuestions']

/** Answer through the existing human-question service while native dispatch stays real. */
export function apply(ctx) {
  ctx.on('user-questions/request', async request => ({ answers: request.questions.map(question => ({
    id: question.id, selected: ['Allow for this task'],
  })) }))
}

/**
 * A real WhisperX transcription response, captured from one live `/api/transcribe`
 * run (the `victor-upmeet/whisperx` pipeline, story 02) and frozen here so dev
 * can exercise the transcript editor without paying Replicate per call. The MSW
 * handler in `handlers.ts` returns this verbatim. Shape matches the pipeline's
 * `{ words: [{ text, start, end, speaker }], text }` contract.
 *
 * All words are tagged SPEAKER_00 (single-narrator clip) so MOCK_STUDIO exercises
 * the diarization path (story 10a).
 */
const TRANSCRIBE_WORDS_BASE = [
    {
      "text": "uh",
      "start": 4.043,
      "end": 4.143
    },
    {
      "text": "in",
      "start": 6.144,
      "end": 6.205
    },
    {
      "text": "this",
      "start": 6.225,
      "end": 6.365
    },
    {
      "text": "session",
      "start": 6.405,
      "end": 6.825
    },
    {
      "text": "i'm",
      "start": 6.945,
      "end": 7.085
    },
    {
      "text": "going",
      "start": 7.145,
      "end": 7.405
    },
    {
      "text": "to",
      "start": 7.445,
      "end": 7.505
    },
    {
      "text": "be",
      "start": 7.545,
      "end": 7.625
    },
    {
      "text": "going",
      "start": 7.665,
      "end": 7.965
    },
    {
      "text": "over",
      "start": 8.106,
      "end": 8.366
    },
    {
      "text": "onboarding",
      "start": 8.986,
      "end": 9.526
    },
    {
      "text": "rules",
      "start": 9.586,
      "end": 9.907
    },
    {
      "text": "in",
      "start": 11.447,
      "end": 11.527
    },
    {
      "text": "this",
      "start": 11.548,
      "end": 11.688
    },
    {
      "text": "session",
      "start": 11.748,
      "end": 12.188
    },
    {
      "text": "i'm",
      "start": 12.648,
      "end": 12.748
    },
    {
      "text": "going",
      "start": 12.768,
      "end": 12.908
    },
    {
      "text": "to",
      "start": 12.928,
      "end": 12.988
    },
    {
      "text": "be",
      "start": 13.028,
      "end": 13.108
    },
    {
      "text": "going",
      "start": 13.128,
      "end": 13.389
    },
    {
      "text": "over",
      "start": 13.469,
      "end": 13.669
    },
    {
      "text": "onboarding",
      "start": 13.969,
      "end": 14.449
    },
    {
      "text": "rules",
      "start": 14.489,
      "end": 14.789
    },
    {
      "text": "onboarding",
      "start": 15.71,
      "end": 16.17
    },
    {
      "text": "rules",
      "start": 16.23,
      "end": 16.57
    },
    {
      "text": "allow",
      "start": 16.69,
      "end": 17.011
    },
    {
      "text": "you",
      "start": 17.071,
      "end": 17.231
    },
    {
      "text": "to",
      "start": 17.311,
      "end": 17.651
    },
    {
      "text": "either",
      "start": 18.591,
      "end": 18.932
    },
    {
      "text": "onboarding",
      "start": 20.713,
      "end": 21.173
    },
    {
      "text": "rules",
      "start": 21.233,
      "end": 21.673
    },
    {
      "text": "allow",
      "start": 21.853,
      "end": 22.253
    },
    {
      "text": "you",
      "start": 22.314,
      "end": 22.494
    },
    {
      "text": "to",
      "start": 22.614,
      "end": 22.914
    },
    {
      "text": "onboarding",
      "start": 27.396,
      "end": 27.857
    },
    {
      "text": "rules",
      "start": 27.897,
      "end": 28.157
    },
    {
      "text": "allow",
      "start": 28.177,
      "end": 28.597
    },
    {
      "text": "you",
      "start": 28.657,
      "end": 28.777
    },
    {
      "text": "to",
      "start": 28.837,
      "end": 28.977
    },
    {
      "text": "promote",
      "start": 29.137,
      "end": 29.638
    },
    {
      "text": "users",
      "start": 29.798,
      "end": 30.178
    },
    {
      "text": "when",
      "start": 30.632,
      "end": 30.792
    },
    {
      "text": "they",
      "start": 30.812,
      "end": 30.952
    },
    {
      "text": "first",
      "start": 30.992,
      "end": 31.233
    },
    {
      "text": "log",
      "start": 31.313,
      "end": 31.533
    },
    {
      "text": "in",
      "start": 31.633,
      "end": 31.773
    },
    {
      "text": "to",
      "start": 31.853,
      "end": 32.033
    },
    {
      "text": "higher",
      "start": 32.133,
      "end": 32.594
    },
    {
      "text": "level",
      "start": 32.654,
      "end": 33.014
    },
    {
      "text": "roles.",
      "start": 33.295,
      "end": 33.775
    },
    {
      "text": "Or",
      "start": 34.456,
      "end": 34.656
    },
    {
      "text": "they",
      "start": 34.976,
      "end": 35.156
    },
    {
      "text": "also",
      "start": 35.276,
      "end": 35.597
    },
    {
      "text": "allow",
      "start": 35.697,
      "end": 35.997
    },
    {
      "text": "you",
      "start": 36.037,
      "end": 36.197
    },
    {
      "text": "to",
      "start": 36.257,
      "end": 36.498
    },
    {
      "text": "run",
      "start": 36.738,
      "end": 36.938
    },
    {
      "text": "pipelines",
      "start": 37.058,
      "end": 37.679
    },
    {
      "text": "if",
      "start": 37.739,
      "end": 37.819
    },
    {
      "text": "you",
      "start": 37.839,
      "end": 37.979
    },
    {
      "text": "want.",
      "start": 38.039,
      "end": 38.299
    },
    {
      "text": "Maybe",
      "start": 38.559,
      "end": 38.82
    },
    {
      "text": "you",
      "start": 38.86,
      "end": 39
    },
    {
      "text": "wanna",
      "start": 39.04,
      "end": 39.3
    },
    {
      "text": "send",
      "start": 39.34,
      "end": 39.54
    },
    {
      "text": "someone",
      "start": 39.58,
      "end": 39.861
    },
    {
      "text": "an",
      "start": 39.901,
      "end": 39.961
    },
    {
      "text": "email",
      "start": 40.061,
      "end": 40.461
    },
    {
      "text": "when",
      "start": 40.902,
      "end": 41.062
    },
    {
      "text": "they",
      "start": 41.122,
      "end": 41.402
    },
    {
      "text": "create",
      "start": 41.722,
      "end": 42.043
    },
    {
      "text": "an",
      "start": 42.083,
      "end": 42.183
    },
    {
      "text": "account",
      "start": 42.263,
      "end": 42.663
    },
    {
      "text": "or",
      "start": 43.284,
      "end": 43.444
    },
    {
      "text": "when",
      "start": 43.644,
      "end": 44.205
    },
    {
      "text": "they",
      "start": 46.327,
      "end": 46.467
    },
    {
      "text": "create",
      "start": 46.507,
      "end": 46.787
    },
    {
      "text": "an",
      "start": 46.807,
      "end": 46.867
    },
    {
      "text": "account.",
      "start": 46.907,
      "end": 47.268
    },
    {
      "text": "There's",
      "start": 48.809,
      "end": 48.949
    },
    {
      "text": "other",
      "start": 48.969,
      "end": 49.149
    },
    {
      "text": "reasons.",
      "start": 49.189,
      "end": 49.61
    }
];

export const TRANSCRIBE_FIXTURE = {
  words: TRANSCRIBE_WORDS_BASE.map((w) => ({ ...w, speaker: "SPEAKER_00" })),
  text: "uh in this session i'm going to be going over onboarding rules in this session i'm going to be going over onboarding rules onboarding rules allow you to either onboarding rules allow you to onboarding rules allow you to promote users when they first log in to higher level roles. Or they also allow you to run pipelines if you want. Maybe you wanna send someone an email when they create an account or when they create an account. There's other reasons.",
};


import { configure } from '@testing-library/react';

// The screens are asynchronous (the worker, the API, browser storage), and the test files run in parallel. On a busy machine the
// testing library's default of one second to find something is tight and makes green tests fail at random: give it room.
configure({ asyncUtilTimeout: 5000 });

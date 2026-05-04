# e-Gov Law Simplifier

[![Code Style: Google](https://img.shields.io/badge/code%20style-google-blueviolet.svg)](https://github.com/google/gts)

The e-Gov Law Simplifier fetches Japanese law data from the e-Gov Law API and parses it into a simplified JSON format. The script extracts structural elements, such as Articles (条), Paragraphs (項), and Items (号), and saves the output to a JSON file.

## How to use
```shell
npm install
node --experimental-strip-types src/main.ts <law-id>

# For example:
# node --experimental-strip-types src/main.ts 129AC0000000089
```

## References

- [e-Gov法令API (e-Gov Law API)](https://laws.e-gov.go.jp/api/2/swagger-ui)

# Remarkable Tools

Remarkable workflow I use for journal, news, and music practice log syncing.

## Setup

### Install necessary dependencies
```shell
npm install
```
Also, gcloud command line tool will need to be installed. See instructions [here](https://cloud.google.com/sdk/docs/install). Set up with default authentication.

If on Mac M1, run the following in order to enable pdf-to-png:
```shell
arch -arm64 brew install pkg-config cairo pango libpng librsvg
```

### Setup dependencies
```shell
gcloud auth application-default login
```

### Run
Generate daily report:
```shell
npm run genreport
```

Sync with connected Remarkable via USB: 
```shell
npm run sync
```
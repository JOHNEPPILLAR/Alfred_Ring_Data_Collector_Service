#!/usr/bin/env sh

echo "Set env vars"
SERVICE_NAME=$(node -p -e "require('./package.json').name")
URL=https://$SERVICE_NAME:$PORT/ping

if [ $ENVIRONMENT != "development" ]
then
    echo "Call url"
    if [ $(curl -L --insecure $URL -o /dev/null -w '%{http_code}\n' -s) == "401" ]
    then exit 0
    else exit 1
    fi
else 
    exit 0
fi

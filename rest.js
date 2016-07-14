/**
 * The logic for processing the mail messages
 */
'use strict';
const request = require('request');
const logger  = require('./logger')();

const config = require('./config');

class Rest {
    constructor() {
        this.config = config.restConfig;
        if (!this.config)
            throw new Error('Fatal error: the REST configuration not found.');
    }

    getModelPath (modelName) {
        const config = this.config;
        const path = config.paths[modelName];
        if (!path)
            throw new Error(`The path for model ${modelName} is not defined in config.js`);

        return [
            config.protocol,
            '://',
            config.host,
            ':',
            config.port,
            '/',
            config.url,
            '/',
            path
        ].join('');
    }

    getAuthObject() {
        const config = this.config;
        return {
            user: config.user,
            pass: config.password,
            sendImmediately: true
        };
    }

    parseEmailAddress(email) {
        //const addressRe = /(.*?[^<])\s*?<(.*)>/;
        const parsed = String(email).match(/<.*>/)[0];
        const address = parsed && parsed.replace(/[<>]*/g, '');
        return address || '';
    }

    getPersonIdByEmail(email) {
        const path = this.getModelPath('Persons');
        const address = this.parseEmailAddress(email);
        const uri = path + '?' + 'email=' + address;
        const options = {
            uri: uri,
            method: 'GET',
            auth: this.getAuthObject()
        };

        const processResponse = (resolve, reject) => (error, response, body) => {
            if (error) {
                logger.error(error);
                reject(email);
                return;
            }

            try {
                const result = JSON.parse(body);
                if (result.ReturnCode !== 0) {
                    logger.error(`Bad server response received from REST interface: ${response}`);
                    reject(email);
                    return;
                }
                if (result['@count'] === 0) {
                    logger.error(`Could not find personId for '${email}'`);
                    reject(email);
                    return;
                }

                const resourceName = result.ResourceName;
                const id = result.content[0][resourceName].Id;
                logger.info(`Found personId: ${id} for '${email}'`);
                resolve(id);
            } catch (e) {
                reject(email);
            }
        };

        if (!address) {
            Promise.reject(email);
        } else {
            return new Promise((resolve, reject) => {
                request(options, processResponse(resolve, reject));
            });
        }
    }

    parseId(prefix, str) {
        const re = new RegExp(prefix + '\\d{12}');
        const parsed = str && str.match && str.match(re);
        const id = parsed && parsed[0];
        return id || '';
    }

    getIssueFromSubject(message) {
        const subject = message.header.subject[0];
        const path = this.getModelPath('Issues');
        const issueId = this.parseId('SRQ', subject);
        const uri = path + '/' + issueId;
        const options = {
            uri: uri,
            method: 'GET',
            auth: this.getAuthObject()
        };

        if (!issueId) {
            return Promise.reject(issueId);
        }

        return new Promise((resolve, reject) => {

            request(options, (error, response, body) => {
                if (error) {
                    logger.error(error);
                    reject(issueId);
                    return;
                }

                try {
                    const result = JSON.parse(body);
                    if (result.ReturnCode !== 0) {
                        logger.error(`The issue with issueId:'${issueId}' not found, return code: ${result.ReturnCode}`);
                        reject(issueId);
                        return;
                    }

                    const issue = result.ZIssue;
                    logger.info(`Found and fetched the issue with issueId: ${issue.Id}`);
                    resolve(issue);

                } catch (e) {
                    reject(issueId);
                }
            });
        });
    }

    makeIssue(message) {
        return {
            id: null,
            title: message.header.subject[0],
            description: message.body || '',
            externalId: message.uid,
            parsedFields: message.parsedFields
        };
    }

    createIssue(issue) {
        const uri = this.getModelPath('Issues');
        const defaults = this.config.defaultIssueAttrs;
        const fields = {
            authorId: issue.id || defaults.authorId,
            customerId: issue.id || null,
            title: issue.title,
            description: issue.description,
            createdOn: new Date(),
            startedOn: new Date(),
            externalId: issue.externalId
        };
        const auth = this.getAuthObject();

        const processResponse = (resolve, reject) => (error, response, body) => {
            if (error || response.statusCode !== 200) {
                let err = error || `Error inserting a new issue`;
                logger.error(err);
                logger.error(response.body.Messages.join(', '));
                reject(err);
                return;
            }

            try {
                if (body.ReturnCode !== 0) {
                    logger.error('Error: could not parse the server response');
                    reject(null);
                    return;
                }

                const message = body.Messages[0];
                const issueId = this.parseId('SRQ', message);
                if (issueId) {
                    logger.info(`Created an issue with id: ${issueId}`);
                    resolve(issueId);
                } else {
                    logger.error('Error: could not parse the issueId from response');
                    reject(null);
                }
            } catch (e) {
                reject(e);
            }
        };

        const updateDates = (obj, timeZone) => {
            Object
                .keys(obj)
                .forEach(field => {
                    if (Date.parse(obj[field])) {
                        //console.log('A date is found %s', obj[field]);
                        obj[field] += timeZone || '+00:00';
                    }
                });
            return obj;
        };

        return new Promise((resolve, reject) => {
            const getIssueObj = () => Object.assign({}, defaults, issue.parsedFields, fields);
            const getOptions = issueObj => {
                return {
                    uri: uri,
                    method: 'POST',
                    auth: auth,
                    body: { ZIssue: issueObj },
                    json: true
                };
            };

            //console.log('issueObj: %s', JSON.stringify(getIssueObj()));

            this.getTimezoneOffsetByPersonId(fields.customerId || fields.authorId)
                .then(offset => {
                    issue.parsedFields = updateDates(issue.parsedFields, offset);
                    Promise.resolve(offset);
                })
                .catch(() => {
                    issue.parsedFields = updateDates(issue.parsedFields);
                    Promise.reject();
                })
                .finally(() => request(getOptions(getIssueObj()), processResponse(resolve, reject)));
        });
    }

    getIssueAttachmentStream(promise, issueId, messageUid, filename, contentType) {
        const uri = this.getModelPath('Issues') + `/${issueId}/attachments`;
        const options = {
            uri: uri,
            method: 'POST',
            auth: this.getAuthObject(),
            headers: {
                'Content-Type': contentType,
                'Content-Disposition': `attachment;filename*=UTF-8''${encodeURIComponent(filename)}`
            }
        };

        const processResponse = (resolve, reject) => (error, response, body) => {
            if (error || response.statusCode !== 200) {
                let err = error || `Error saving attachment '${filename}' for msg uid:${messageUid}`;
                logger.error(err);
                resolve(err);
                return;
            }

            try {
                const result = JSON.parse(body);
                if (result.ReturnCode !== 0) {
                    logger.error(`Bad server response: ${response} while trying to save attachment '${filename}'`);
                    resolve(null);
                    return;
                }

                logger.info(`Saved attachment ${filename} for issue: ${issueId}`);
                resolve(issueId);
            } catch (e) {
                // Resolve anyway
                resolve(e);
            }
        };

        return request(options, processResponse(promise.resolve, promise.reject));
    }

    createComment(comment) {
        const uri = this.getModelPath('Comments');
        const defaults = this.config.defaultIssueAttrs;
        const fields = {
            authorId: comment.authorId || defaults.authorId,
            comment: comment.description,
            createdOn: new Date(),
            foreignKey: comment.issueId,
            isPublic: true
        };
        // Пример
        //{"ZComment": {
        //    "AuthorId": "PRS000000000001",
        //    "Comment": "<p>По данному вопросу we need help&nbsp;</p>",
        //    "CreatedOn": "2016-02-12T07:45:15+00:00",
        //    "ForeignKey": "SRQ000000000354",
        //    "IsPublic": "false"
        //    }
        //}

        const commentObj = Object.assign({}, fields);
        const options = {
            uri: uri,
            method: 'POST',
            auth: this.getAuthObject(),
            body: { ZComment: commentObj },
            json: true
        };

        const processResponse = (resolve, reject) => (error, response, body) => {
            if (error || response.statusCode !== 200) {
                let err = error || `Error inserting a new comment`;
                logger.error(err);
                logger.error(response.body.Messages.join(', '));
                reject(err);
                return;
            }

            try {
                if (body.ReturnCode !== 0) {
                    logger.error('Error: could not parse the server response');
                    reject(null);
                    return;
                }

                const message = body.Messages[0];
                const commentId = this.parseId('CMT', message);
                if (commentId) {
                    logger.info(`Created a comment with id: ${commentId}`);
                    resolve(commentId);
                } else {
                    logger.error('Error: could not parse the commentId from response');
                    reject(null);
                }
            } catch (e) {
                reject(e);
            }
        };

        return new Promise((resolve, reject) => {
            request(options, processResponse(resolve, reject));
        });
    }

    getCommentAttachmentStream(promise, commentId, messageUid, filename, contentType) {
        const uri = this.getModelPath('Comments') + `/${commentId}/attachments`;
        const options = {
            uri: uri,
            method: 'POST',
            auth: this.getAuthObject(),
            headers: {
                'Content-Type': contentType,
                'Content-Disposition': `attachment;filename*=UTF-8''${encodeURIComponent(filename)}`
            }
        };

        const processResponse = (resolve, reject) => (error, response, body) => {
            if (error || response.statusCode !== 200) {
                const err = error || `Error saving attachment '${filename}' for msg uid:${messageUid}`;
                logger.error(err);
                logger.info('Bad response: ' + JSON.stringify(response || body));
                reject(err);
                return;
            }

            try {
                const result = JSON.parse(body);
                if (result.ReturnCode !== 0) {
                    logger.error(`Bad server response: ${response} while trying to save attachment '${filename}'`);
                    reject(null);
                    return;
                }

                logger.info(`Saved attachment ${filename} for comment: ${commentId}`);
                resolve(commentId);
            } catch (e) {
                reject(e);
            }
        };

        return request(options, processResponse(promise.resolve, promise.reject));
    }

    checkSpamByPersonId(personId, message) {
        const spam = config.restConfig.spam;
        const uri = config.restConfig.dbQueryUri;
        const query = [
            'SELECT COUNT(*) AS ISSUES',
            'FROM Z_ISSUES',
            `WHERE CUSTOMER_ID = '${personId}'`,
            `AND DATEDIFF(MINUTE, CREATED_ON, GETUTCDATE()) <= ${spam.timeSpan}`
        ].join(' ');
        const options = {
            uri: uri,
            method: 'POST',
            headers: {
                'Content-Type': 'text/plain'
            },
            body: query,
            json: false
        };

        if (spam.dontCheckAuthors.indexOf(personId) !== -1) {
            logger.info(`No spam check performed for personId: ${personId}`);
            return Promise.resolve(personId);
        }

        const hasSpamHeaders = spam.headers.some(header => !!message.header[header]);
        if (hasSpamHeaders) {
            logger.info(`Spam alert: found an auto-reply header`);
            return Promise.reject(personId);
        }

        return new Promise((resolve, reject) => {

            request(options, (error, response, body) => {
                if (error || response.statusCode !== 200) {
                    logger.error(error || `Error making the server request for personId:${personId}`);
                    resolve(personId);
                    return;
                }

                try {
                    const result = JSON.parse(body);
                    if (!result.results || !result.results.length) {
                        logger.error(`The request for personId:'${personId}' was not successful`);
                        resolve(personId);
                        return;
                    }

                    const issues = result.results[0].ISSUES;
                    if (issues > spam.maxNumOfIssues) {
                        const msg = [
                            `Spam alert: the number of issues '${issues}' from ${personId} during the last`,
                            `${spam.timeSpan} minutes exceeds the maximum allowed: ${spam.maxNumOfIssues}`
                        ].join(' ');
                        logger.error(msg);
                        reject(personId);
                    } else {
                        logger.info(`Spam test passed: found ${issues} issue(s) for the last ${spam.timeSpan} minutes`);
                        resolve(personId);
                    }

                } catch (e) {
                    logger.error(e);
                    resolve(personId);
                }
            });
        });
    }

    getTimezoneOffsetByPersonId(personId) {
        const uri = config.restConfig.dbQueryUri;
        const query = [
            'SELECT ISNULL(tzo.offset, tzo1.offset) AS OFFSET',
            'FROM dbo.z_persons AS p',
            'LEFT JOIN dbo.z_time_zones tz ON p.time_zone_id = tz.id',
            'LEFT JOIN dbo.z_time_zone_offsets tzo ON tz.id = tzo.time_zone_id',
            'CROSS JOIN dbo.z_system_settings AS ss',
            'LEFT JOIN dbo.z_time_zone_offsets AS tzo1 ON tzo1.time_zone_id = ss.time_zone_id',
            `WHERE p.id = '${personId}' AND (tzo.switched_on <= GETUTCDATE() OR tzo1.switched_on <= GETUTCDATE())`,
            'ORDER BY tzo.switched_on DESC, tzo1.switched_on DESC'
        ].join(' ');
        const options = {
            uri: uri,
            method: 'POST',
            headers: {
                'Content-Type': 'text/plain'
            },
            body: query,
            json: false
        };

        const id = this.parseId('PRS', personId);
        if (!id) {
            return Promise.reject(personId);
        }

        return new Promise((resolve, reject) => {

            request(options, (error, response, body) => {
                if (error || response.statusCode !== 200) {
                    logger.error(error || `Error fetching the timezone for personId:${personId}`);
                    reject(personId);
                    return;
                }

                try {
                    const result = JSON.parse(body);
                    if (!result.results || !result.results.length) {
                        logger.error(`The timezone request for personId:${personId} was not successful`);
                        reject(personId);
                        return;
                    }

                    const offset = result.results[0].OFFSET;
                    if (!offset) {
                        logger.error(`Error: timezone offset for personId:${personId} could not be determined`);
                        reject(personId);
                    } else {
                        resolve(offset);
                    }

                } catch (e) {
                    logger.error(e);
                    reject(personId);
                }
            });
        });
    }

}

module.exports = () => new Rest();

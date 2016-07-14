/**
 * IMAP service
 */
'use strict';

const base64        = require('base64-stream');
const inspect       = require('util').inspect;
const cheerio       = require('cheerio');
const MailParser    = require('mailparser').MailParser;
const Imap          = require('imap');
const logger        = require('./logger')();
const BufferStream  = require('./buffer-stream');
const restConfig    = require('./config').restConfig;
const rest          = require('./rest')();

class Multimap {
    constructor (servers) {
        this.connections = [];
        Object
            .keys(servers)
            .forEach(server => {
                this.init(servers[server]);
            });
    }

    init(server) {

        let conn = new Imap(server.imapConfig);
        conn.config = server;
        conn.reconnect = undefined;

        conn.getSuccessBoxName = (boxName) => {
            const boxConfig = conn.config.mailboxConfig;
            const delimiter = conn.delimiter || '';
            return boxConfig ? `${boxName}${delimiter}${boxConfig[boxName].success}` : null;
        };

        conn.getFailureBoxName = (boxName) => {
            const boxConfig = conn.config.mailboxConfig;
            const delimiter = conn.delimiter || '';
            return boxConfig ? `${boxName}${delimiter}${boxConfig[boxName].failure}` : null;
        };

        conn.clearInterval = function () {
            if (this.interval)
                clearInterval(this.interval);
        }.bind(conn);

        conn.getHost = () => conn.config.imapConfig.host;

        conn.once('close', (hadError) => {
            // This fires on any closed connection
            conn.isRunning = false;
            logger.info(`IMAP server '${conn.getHost()}' shut down` + (hadError ? ` due to an error` : ''));

            const reconnect = () => {
                if (conn.state === 'disconnected') {
                    conn.connect();
                } else if (conn.reconnect && ~conn.reconnect._idleTimeout) {
                    clearInterval(conn.reconnect);
                    conn.reconnect = undefined;
                }
            };

            if (hadError && !conn.reconnect && conn.interval && ~conn.interval._idleTimeout) {
                conn.clearInterval();
                console.log(`Requesting reconnect for ${conn.getHost()}`);
                conn.reconnect = setInterval(reconnect, 10000);
            }
        });

        conn.once('end', () => {
            logger.info(`Connection to '${conn.getHost()}' reset`);
        });

        conn.once('error', (err) => {
            // Note: this always fires when issuing an IMAP.end() command from under a WIN Server
            if (err.errno === 'ECONNRESET') {
                if (conn.interval && ~conn.interval._idleTimeout) {
                    logger.error(`'${conn.getHost()}' connection error: ${inspect(err)}`);
                } else {
                    logger.error(`Connection to '${conn.getHost()}' reset`);
                }
            } else {
                logger.error(`'${conn.getHost()}' i-connection error: ${inspect(err)}`);
            }
        });

        conn.once('ready', () => {
            logger.info(`Established connection to IMAP server '${conn.getHost()}'`);
            if (!conn.interval || !~conn.interval._idleTimeout) {
                this.processMailboxes(conn)();
            }
            conn.interval = setInterval(this.processMailboxes(conn), restConfig.queryInterval);
        });

        this.connections.push(conn);
    }

    disconnect(conn) {
        conn.clearInterval();
        if (conn.state !== 'disconnected') {
            conn.isRunning = false;
            logger.info(`Disconnect for '${conn.getHost()}' requested`);
            conn.end();
        }
    }

    run() {
        console.log('node-imap server started');
        this.connections.forEach(conn => {
            if (conn.state === 'disconnected')
                conn.connect();
        });
    }

    stop() {
        let interval;
        const getRunning = () => {
            return this.connections.reduce((all, conn) => {
                return all.concat(conn.state !== 'disconnected' || conn.isRunning ? conn : []);
            }, []);
        };
        const stop = (resolve, reject) => () => {
            const running = getRunning();
            if (!running.length) {
                if (interval)
                    clearInterval(interval);
                resolve();
                return;
            }
            running.forEach(conn => {
                this.disconnect(conn);
            });
        };

        logger.info('Wait a moment, shutting down servers...');

        return new Promise((resolve, reject) => {
            interval = setInterval(stop(resolve, reject), 500);
        });
    }

    processMailboxes(conn) {
        return () => {
            //console.log(`${conn.getHost()} connection state: ${conn.state}`);

            if (conn.state === 'disconnected') {
                conn.isRunning = false;
                return;
            }

            if (conn.isRunning) return;

            conn.isRunning = true;
            this.checkBoxes(conn)
                .then(boxes => {
                    logger.info(`Finished checking the mailbox configuration for '${conn.getHost()}'`);
                    boxes
                        .reduce((promise, boxName) => {
                            return promise.then(() => {
                                return this.processBox(conn, boxName)
                                    .then(boxName => null)
                                    .catch(boxName => null);
                            });
                        }, Promise.resolve())
                        .then(() => {
                            logger.info(`Done for all mailboxes of ${conn.getHost()}, going to IDLE state...`);
                            //console.log('Going to IDLE state...');
                            conn.isRunning = false;
                        })
                        .catch(error => {
                            logger.error(error);
                            conn.isRunning = false;
                        });
                })
                .catch(boxes => {
                    logger.error('The configured mailboxes could not be found: %s', boxes);
                    //logger.error('Please check the server configuration');
                });
        };
    }

    checkBoxes(conn) {

        logger.info(`Started checking mailboxes configuration for ${conn.getHost()}`);
        return new Promise((resolve, reject) => {

            conn.getBoxes('', (err, boxes) => {
                if (err) {
                    logger.error('Error checking mailboxes: ' + err);
                    reject(err);
                }

                let success = [];
                let failure = [];
                let checked = true;
                const logCheckResult = (boxName, result) => {
                    if (!result)
                        logger.error(`Checking mailbox '${boxName}': failed to open`);

                    checked = !result && checked ? false : checked;
                };
                const config = conn.config.mailboxConfig;

                Object
                    .keys(config)
                    .forEach(name => {
                        if (name in boxes) {
                            logCheckResult(name, true);
                            // Проверка вложенных ящиков
                            const children = boxes[name].children;
                            const delimiter = conn.delimiter || '/';
                            let box = config[name].success;
                            let tmpBoxName = `${name}${delimiter}${box}`;
                            logCheckResult(tmpBoxName, children && box in children);

                            box = config[name].failure;
                            tmpBoxName = `${name}${delimiter}${box}`;
                            logCheckResult(tmpBoxName, children && box in children);
                        } else {
                            logCheckResult(name, true);
                        }

                        if (checked)
                            success.push(name);
                        else
                            failure.push(name);
                        // Reset the logic var
                        checked = true;
                    });

                if (success.length) {
                    resolve(success);
                } else {
                    reject(failure);
                }
            });
        });
    }

    findAttachmentParts(struct) {
        const isAttachment = (type) => ~['INLINE', 'ATTACHMENT'].indexOf(type.toUpperCase());

        return struct.reduce((all, part) => {
            if (Array.isArray(part)) {
                return all.concat(this.findAttachmentParts(part));
            } else {
                if (part.disposition && isAttachment(part.disposition.type)) {
                    return all.concat(part);
                }
                return all;
            }
        }, []);
    }

    findBodyParts(struct) {

        return struct.reduce((all, part) => {
            if (Array.isArray(part)) {
                return all.concat(this.findBodyParts(part));
            } else {
                if (part.type.toLowerCase() === 'text' && !part.disposition) {
                    return all.concat(part);
                }
                return all;
            }
        }, []);
    }

    moveMessageFn(conn, boxName) {
        return (message) => {

            if (!boxName) {
                Promise.reject('No box name');
            }

            return new Promise((resolve, reject) => {
                const uid = message.uid;
                conn.move(uid, boxName, err => {
                    if (err) {
                        logger.error(`Error moving the message id: ${uid} to ${boxName}`);
                        reject(uid);
                    } else {
                        logger.info(`Message id: ${uid} successfully moved to ${boxName}`);
                        resolve(uid);
                    }
                });
            });
        };
    }

    saveEmlAsAttachment(conn, message, issueId) {
        const messageUid = message.uid;
        const filename = messageUid + '-message.eml';
        const joinOriginalAsEml = rest.config.joinOriginalAsEml;

        if (!joinOriginalAsEml) {
            return Promise.resolve();
        }

        return new Promise((resolve, reject) => {
            const f = conn.fetch(messageUid, { bodies: '' });

            f.on('message', (msg) => {
                const promise = { resolve, reject };
                const writeStream = rest.getIssueAttachmentStream(promise, issueId, messageUid, filename, 'message/rfc822');

                writeStream.on('error', (error) => {
                    logger.error(error);
                    resolve(issueId);
                });

                msg.on('body', (stream, info) => {
                    stream.pipe(writeStream);
                });
            });
            f.once('error', (err) => {
                logger.error(`Message uid:${messageUid} fetch error: ` + err);
                // resolve despite the error
                resolve(issueId);
            });
            f.once('end', () => {
                logger.info('Done fetching message uid: %s', messageUid);
            });
        });
    }

    saveMessageAttachments(conn, message, obj) {
        const joinAttachments = rest.config.joinAttachments;

        const saveOneAttachment = (uid) => (attachment) => {

            return new Promise((resolve, reject) => {
                const filename = attachment.fileName;
                const encoding = attachment.transferEncoding;
                const contentType = attachment.contentType;
                const size = attachment.length;
                const promise = { resolve, reject };
                const id = obj.id;

                logger.info(`Saving attachment '${filename}', size: ${size} bytes for msg uid: ${uid}`);

                const readStream = new BufferStream(attachment.content);
                const writeStream = obj.type === 'ZIssue' ?
                    rest.getIssueAttachmentStream(promise, id, uid, filename, contentType) :
                    rest.getCommentAttachmentStream(promise, id, uid, filename, contentType);

                writeStream.on('error', (error) => {
                    logger.error(`Error saving attachment for msg uid: ${uid} -> ${error}`);
                    // Важно: даже при ошибке сохранения вложенных файлов всегда вызываем Resolve
                    resolve(message);
                });

                readStream.pipe(writeStream);
            });
        };

        if (!joinAttachments) {
            return Promise.resolve();
        }

        return new Promise((resolve, reject) => {
            const attachments = message.attachments;
            if (attachments.length) {
                Promise
                    .all(attachments.map(saveOneAttachment(message.uid)))
                    .finally(() => resolve(message));
            } else {
                resolve(message);
            }
        });
    }

    /**
     * Parses the date to the format YYYY-MM-DD hh:mm
     * @param {String} dateStr
     * @returns {Date || NaN} Either the parsed date object or NaN
     */
    parseDate(dateStr) {
        const dateRe = /(\d{2})[-\/](\d{2})[-\/](\d{4})\s*(\d{2}:\d{2})?/;
        const matched = dateStr.replace &&
            dateStr.replace(dateRe, (match, p1, p2, p3, p4) => {
                return `${p3}-${p2}-${p1}T` + (p4 ? `${p4}:00`  : '23:59:59');
            });
        //console.log('Matched date: ', matched);
        const date = matched && new Date(matched);
        return date && date !== 'Invalid Date' ? matched : NaN;
    }

    /**
     * Finds & parses permitted attributes in the message body
     * @param message
     * @returns Object having { fieldName: parsedValue }
     */
    parsePermittedAttributes(message) {
        const attrs = restConfig.permittedBodyAttributes;
        const headRe = '\\s?[-;:]?\\s*';
        const tailRe = '.*?\\s';
        const types = {
            date: '(\\d{2}[-\/]\\d{2}[-\/]\\d{4}\\s*([0-2][0-9]:[0-5][0-9])?)',
            id: '([a-zA-Z]{3}\\d{12})',
            string: '(.+)'
        };
        const $ = cheerio.load(message.body);
        const body = $('body').text() || message.body;

        //console.log('Parsed body: ' + body);
        return Object
            .keys(attrs)
            .reduce((fields, key) => {
                const type = attrs[key];
                const re = new RegExp(key + headRe + (types[type] || types.string) + tailRe, 'i');
                const match = re.exec(body);
                if (match) {
                    if (type === 'date') {
                        let date = this.parseDate(match[1]);
                        if (date)
                            fields[key] = date;
                    } else {
                        fields[key] = match[1];
                    }
                }

                return fields;
            }, {});
    }

    isHtml(str) {
        return /^<\s*html[^>]*>/i.test(str);
    }

    /**
     * Parses the message body and truncates it after a given delimiter
     * or multiple delimiters specified in the configuration
     * @param body { String } Can be either html or text
     * @returns { String }
     */
    removeComments(body) {
        const delimiters = restConfig.commentDelimiters;
        const shouldTruncate = restConfig.truncateCommentsAfterDelimiter && delimiters.length;
        if (!shouldTruncate) {
            return body;
        }

        const isRe = obj => Object.prototype.toString.call(obj) === '[object RegExp]';

        // The document is not in html format
        if (!this.isHtml(body)) {
            let result = body;
            delimiters.forEach(delimiter => {
                const i = result.search(delimiter);
                result = i !== -1 ? result.substring(0, i) : result;
            });
            return result.replace(/\r?\n/g, '<br>');
        }

        // The document is in html format
        const $ = cheerio.load(body);
        const $body = $('body');

        /**
         * Finds an element matching the regular expression
         * @param $where Where to look (valid Cheerio object)
         * @param re The RegExp to look for
         * @returns { Object } Returns the element found, otherwise returns null
         */
        const findElement = ($where, re) => {
            const traverse = (arr, re) => {
                let set = [];

                arr.each(function (i, el) {
                    const children = $(el).children();

                    if (children.length) {
                        set = set.concat(traverse(children, re));
                    } else {
                        if (re.test($(el).text())) {
                            set.push($(el));
                            return false;
                        } else if (re.test($(el).parent().text())) {
                            set.push($(el).parent());
                            return false;
                        }
                    }
                });
                return set;
            };

            if ($where.children().length) {
                let result = traverse($where.children(), re);
                return result.length ? result[0] : null;
            } else {
                if (re.test($where.text())) {
                    return $where;
                } else {
                    return null;
                }
            }
        };

        /**
         * Truncates the document below the element including the el itself
         * @param el The element to start truncation with
         */
        const truncate = el => {
            let $parent = el.parent();
            // Remove this element and its right siblings
            el.nextAll().remove();
            if (el.is('body')) {
                el.empty();
                return;
            } else {
                el.remove();
            }
            while (!$parent.is('body')) {
                let $prevParent = $parent;
                $parent = $prevParent.parent();
                $prevParent.nextAll().remove();
            }
        };

        delimiters.forEach(delimiter => {
            const getBodyText = () => $body.text();
            const re = isRe(delimiter) ? delimiter : new RegExp(delimiter);
            const $bodyText = getBodyText();

            if (re.test($bodyText)) {
                let found = findElement($body, re);
                if (found) {
                    truncate(found);
                }
            }
        });

        return $.html();
    }

    getMessageBody(conn, message) {

        const getEntireMessage = (resolve, reject, message) => {
            const uid = message.uid;

            return (msg) => {
                const writeStream = new MailParser();

                writeStream.on('end', (mail) => {
                    message.body = mail.html || mail.text;
                    message.parsedFields = this.parsePermittedAttributes(message);
                    message.body = this.removeComments(message.body);
                    message.attachments = mail.attachments ? mail.attachments.slice(0) : [];
                    // The parsed mails can be heavy enough, so clean up the buffer for better GC
                    mail = undefined;
                    logger.info(`B2. Message uid: ${uid} entirely fetched and parsed`);
                    resolve(message);
                });

                msg.on('body', (stream, info) => {
                    logger.info(`B1. Fetching msg uid: ${uid}, body size: ${info.size} bytes`);
                    stream.pipe(writeStream);
                });
            };
        };

        return new Promise((resolve, reject) => {
            const f = conn.fetch(message.uid, {
                bodies: '',
                struct: true
            });
            //pipe function to process attachment message
            f.on('message', getEntireMessage(resolve, reject, message));
            f.once('error', (error) => {
                logger.error(`Error fetching the msg uid: ${message.uid} -> ${error}`);
                // Важно: даже при ошибке сохранения вложенных файлов всегда возвращаем Resolve
                reject(message);
            });
        });
    }

    processBox(conn, boxName) {

        if (!conn.isRunning) {
            return Promise.reject(boxName);
        }

        return new Promise((resolve, reject) => {

            conn.openBox(boxName, false, (err, box) => {
                if (err) {
                    reject(boxName);
                    logger.error('Error opening the box: %s', inspect(err));
                    return;
                }

                const maxQueryMessages = restConfig.maxQueryMessages;
                conn.search(['UNSEEN'], (err, uids) => {
                    if (err) {
                        reject(boxName);
                        return;
                    }

                    //console.log(`${uids.length} messages fetched by 'search'`);

                    if (!uids.length) {
                        resolve(boxName);
                        return;
                    }

                    const ids = uids.slice(0, maxQueryMessages);

                    const f = conn.fetch(ids, {
                        //bodies: ['HEADER.FIELDS (FROM SUBJECT DATE)'],
                        bodies: ['HEADER'],
                        struct: true,
                        markSeen: true
                    });
                    let messages = [];

                    f.on('message', (msg, seqno) => {
                        let message = {};

                        msg.on('body', (stream) => {
                            let buffer = '';

                            stream.on('data', (chunk) => {
                                buffer += chunk.toString('utf8');
                            });
                            stream.once('end', () => {
                                message.header = Imap.parseHeader(buffer);
                                //logger.info('#' + seqno + ' headers parsed %s', inspect(message.header));
                                logger.info('#' + seqno + ' headers parsed');
                            });
                        });

                        msg.once('attributes', (attrs) => {
                            const bodies = this.findBodyParts(attrs.struct);
                            const attachments = this.findAttachmentParts(attrs.struct);

                            message.uid = attrs.uid;
                            message.attachments = attachments;
                            message.bodies = bodies;
                            message.body = '';

                            logger.info(`Msg uid: ${attrs.uid} has ${attachments.length} attachment(s), ${bodies.length} body part(s)`);
                        });

                        msg.once('end', () => {
                            messages.push(Object.assign({}, message));
                        });
                    });

                    f.once('error', (err) => {
                        // Do not log this, since it can emit errors like:
                        // `Error: The specified message set is invalid.`
                        // logger.info('Fetch error: ' + err);
                        reject(boxName);
                    });

                    f.once('end', () => {
                        // 0. read mail from IMAP, parse it
                        // 1. then create an issue via rest
                        // 2. then save attachments via rest
                        // 3. then only move the message to `boxName.success`
                        // 4. on error, try to move the message to `boxName.failure`
                        // 5. when all messages are processed -> move on to the next mailbox
                        logger.info(`Done fetching ${messages.length} message(s) from '${boxName}'`);

                        const processMessage = message => {
                            // 1. If the subject has an issueId
                            // 2. +then create a new comment and save the attachments if any
                            // 3. -catch proceed with doCreateIssue

                            if (!conn.isRunning) {
                                return Promise.reject();
                            }

                            return rest
                                .getIssueFromSubject(message)
                                .then(issue => this.doCreateComment(conn, boxName, issue, message))
                                .catch(() => this.doCreateIssue(conn, boxName, message));
                        };

                        if (!messages.length) {
                            resolve(boxName);
                            return;
                        }

                        Promise
                            .all(messages.map(processMessage))
                            .then(() => resolve(boxName))
                            .catch(() => resolve(boxName));
                    });
                });
            });
        });
    }

    doCreateComment(conn, boxName, issue, message) {
        const moveMessageOnSuccess = this.moveMessageFn(conn, conn.getSuccessBoxName(boxName));
        const moveMessageOnFailure = this.moveMessageFn(conn, conn.getFailureBoxName(boxName));

        return this.getMessageBody(conn, message)
            .then(() => {
                const email = message.header.from[0];
                const comment = {
                    authorId: null,
                    issueId: issue.Id,
                    description: message.body
                };

                return rest
                    .getPersonIdByEmail(email)
                    .catch(() => {
                        return rest
                            .createComment(comment)
                            .then(commentId => this.saveMessageAttachments(conn, message, { type: 'ZComment', id: commentId }))
                            .then(() => moveMessageOnSuccess(message).catch(() => Promise.resolve()))
                            .catch(() => moveMessageOnFailure(message))
                            .finally(() => Promise.reject());
                    })
                    .then(authorId => {
                        return rest
                            .checkSpamByPersonId(authorId, message)
                            .then(authorId => Promise.resolve(authorId))
                            .catch(() => moveMessageOnFailure(message).finally(() => Promise.reject()));
                    })
                    .then(authorId => Object.assign({}, comment, { authorId }))
                    .then(comment => {
                        return rest
                            .createComment(comment)
                            .then(commentId => this.saveMessageAttachments(conn, message, { type: 'ZComment', id: commentId }))
                            .then(() => moveMessageOnSuccess(message).catch(() => Promise.resolve()))
                            .catch(() => moveMessageOnFailure(message))
                            .finally(() => Promise.resolve());
                    })
                    .finally(() => Promise.resolve());
            })
            .catch(() => Promise.resolve());
    }

    doCreateIssue(conn, boxName, message) {
        const createSystemIssue = rest.config.onPersonNotFound.createSystemIssue;
        const email = message.header.from[0];
        const moveMessageOnSuccess = this.moveMessageFn(conn, conn.getSuccessBoxName(boxName));
        const moveMessageOnFailure = this.moveMessageFn(conn, conn.getFailureBoxName(boxName));

        return this.getMessageBody(conn, message)
            .then(() => rest.getPersonIdByEmail(email))
            .catch(() => {
                if (createSystemIssue) {
                    return rest
                        .createIssue(rest.makeIssue(message))
                        .catch(() => moveMessageOnFailure(message).finally(() => Promise.reject()))
                        .then((issueId) => this.saveEmlAsAttachment(conn, message, issueId))
                        .then((issueId) => this.saveMessageAttachments(conn, message, { type: 'ZIssue', id: issueId }))
                        .then(() => moveMessageOnSuccess(message))
                        .finally(() => Promise.reject());
                } else {
                    return moveMessageOnFailure(message)
                        .finally(() => Promise.reject());
                }
            })
            .then(authorId => {
                return rest
                    .checkSpamByPersonId(authorId, message)
                    .catch(() => moveMessageOnFailure(message).finally(() => Promise.reject()))
                    .then(authorId => Promise.resolve(authorId));
            })
            .then(id => {
                return rest
                    .createIssue(Object.assign({}, rest.makeIssue(message), { id }))
                    .catch(() => moveMessageOnFailure(message).then(() => Promise.reject()))
                    .then((issueId) => this.saveEmlAsAttachment(conn, message, issueId))
                    .then((issueId) => this.saveMessageAttachments(conn, message, { type: 'ZIssue', id: issueId }))
                    .then(() => moveMessageOnSuccess(message));
            });
    }

}

const servers = require('./config').servers;

module.exports = new Multimap(servers);

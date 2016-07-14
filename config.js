/**
 * Файл настроек приложения
 */

// Настройки серверов и почтовых ящиков
const servers = {
    instance01: {
        // Конфигурация сервера
        imapConfig: {
            user: 'test@example.ru',
            password: 'password',
            host: 'imap.example.ru',
            port: 993,
            tls: true,
            autotls: 'always'
        },
        // Конфигурация почтовых ящиков для входящих заявок и соответствующих им ящиков,
        // в которые перемещаются удачно или неудачно обработанные сообщения
        mailboxConfig: {
            // Возможно иметь несколько почтовых ящиков (названия ящиков могут быть произвольными),
            // напр: {'INBOX', 'ЗАЯВКИ', 'Service Requests'}
            // При настройке ящиков `INBOX` должен находиться в корне дерева ящиков, а
            // ящики `Обработанные` и `Необработанные` должны быть вложены в ящик `INBOX`
            'INBOX': {
                success: 'Обработанные',
                failure: 'Необработанные'
            },
            'Drafts': {
                success: 'Обработанные',
                failure: 'Необработанные'
            }
        }
    },
    //mailru: {
    //    imapConfig: {
    //        user: 'testmail@mail.ru',
    //        password: 'password',
    //        host: 'imap.mail.ru',
    //        port: 993,
    //        tls: true,
    //        autotls: 'always'
    //    },
    //    mailboxConfig: {
    //        'Отправленные': {
    //            success: 'Да',
    //            failure: 'Нет'
    //        }
    //    }
    //}
};

const restConfig = {
    user: 'system',
    password: 'system',
    protocol: 'http',
    host: '192.168.102.105',
    port: 16485,
    url: 'SM/9/rest',
    paths: {
        Issues: 'zIssues',
        Persons: 'zPersons',
        Comments: 'zComments'
    },

    dbQueryUri: 'http://192.168.102.105:26485/search',

    // Значение maxQueryMessages вряд ли должно быть больше 10, поскольку
    // в любом случае все завки во всех ящиках обрабатываются в непрерывном цикле.
    // Это обеспечит равномерную обработку заявок, если ящиков несколько
    maxQueryMessages: 1,
    queryInterval: 20000,

    onPersonNotFound: {
        // Важно: Выбрать только одно из действий
        createSystemIssue: false,
        moveMsgToFailureFolder: true
    },
    // Атрибут, разрешенные для передачи через тело сообщения
    // Возможные значения: `date`, `id`, `string`
    // Если нет значений, оставить пустой объект
    permittedBodyAttributes: {
        requiredOn: 'date',
        agreementId: 'id',
        //serviceId: 'id',
        phaseId: 'id',
        teamId: 'id'
    },

    // Значение полей заявки по умолчанию
    defaultIssueAttrs: {
        // Системный автор для заявок в случае, если автора нет в таблице `zPersons`
        authorId: 'PRS000000000001',
        statusId: 'STS000000000001',
        categoryId: 'CTG000000000101',
        priorityId: 'PRT000000000003',
        sourceId: 'SRC000000000003',
        //serviceId: 'SRV000000000001'
        //phaseId: 'WPH000000000001'
    },

    // Управление вложениями
    joinOriginalAsEml: true,
    joinAttachments: true,

    // Отсечение тела сообщения после определенного набора символов
    truncateCommentsAfterDelimiter: true,
    // Здесь можно указывать как строковые константы, так и регулярные выражения
    // Все значения разделителей будут обработаны последовательно
    // При отсутствии значений оставить пустой массив
    commentDelimiters: [
        // это эквивалент строки '//-----------'
        /\/\/-+/,
        'Best regards',
        'С уважением'
    ],

    // Проверка на спам
    spam: {
        // Промежуток времени в минутах, за который пользователь должен прислать
        // не более, чем `maxNumOfIssues` сообщений на все ящики вместе взятые
        // Пример: 30 минут
        timeSpan: 30,
        maxNumOfIssues: 5,
        headers: [
            'auto-generated',
            'auto-replied',
            'auto-notified'
        ],
        dontCheckAuthors: [
            'PRS000000000001'
        ]
    }
};

module.exports = {
    servers,
    restConfig
};
